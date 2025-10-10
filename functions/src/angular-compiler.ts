import { NgtscProgram } from '@angular/compiler-cli';
import type { CompilerOptions as NgcCompilerOptions } from '@angular/compiler-cli';
import * as path from 'path';
import * as crypto from 'crypto';
import * as functions from 'firebase-functions';
import * as prettier from 'prettier';
import * as ts from 'typescript';
import {
  cacheCompilation,
  CompileResponse,
  createOptimizedHost,
  getCachedCompilation,
  preWarmModuleCache,
} from './cache-manager';

// Global virtual entry file path used across the module (must be absolute for Angular)
const VIRTUAL_FILE = path.resolve(process.cwd(), 'main.ts');

const sharedCompilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  skipLibCheck: true, // Skip lib checking for faster compilation but enable template checking
  skipDefaultLibCheck: true, // Skip default lib checking
  sourceMap: false,

  // Required for Angular decorators
  experimentalDecorators: true,
  emitDecoratorMetadata: true,

  // Helpful strictness that doesn't slow down much
  strict: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  noFallthroughCasesInSwitch: true,

  // Performance optimizations
  isolatedModules: true,
  assumeChangesOnlyAffectDirectDependencies: true,
  disableSourceOfProjectReferenceRedirect: true,

  // Skip unnecessary checks for faster compilation
  noResolve: false, // Keep this false for Angular imports
  noImplicitAny: false, // Allow implicit any for faster compilation
  noImplicitReturns: false // Skip strict return checking
};

// Angular-specific compiler options for strict template checking
const angularCompilerOptions: Partial<NgcCompilerOptions> = {
  // Align with angularCompilerOptions in root tsconfig.json
  enableI18nLegacyMessageIdFormat: false,
  strictInjectionParameters: true,
  strictInputAccessModifiers: true,
  typeCheckHostBindings: true,

  // Strict template type checking flags
  strictTemplates: true,
  strictAttributeTypes: true,
  strictNullInputTypes: true,
  strictInputTypes: true,
  strictSafeNavigationTypes: true,
  strictDomLocalRefTypes: true,
  strictOutputEventTypes: true,
  strictDomEventTypes: true,
  strictContextGenerics: true,
  strictLiteralTypes: true,
  enableBlockSyntax: true,
  enableLetSyntax: true,

  // CRITICAL: Ensure template type checker is enabled
  enableTemplateTypeChecker: true,
  // Report additional template issues like unknown members
  extendedTemplateDiagnostics: true as any,
  // Force full AOT compilation for apps (needed for template type checking)
  compilationMode: 'full',
  // Additional options that might be needed for template type checking
  allowEmptyCodegenFiles: true,
  generateDeepReexports: false,
};

// Pre-warm the module cache when the module loads (once per instance)
(async () => {
  try {
    await preWarmModuleCache(sharedCompilerOptions);
  } catch (error) {
    functions.logger.warn('Pre-warming failed:', error);
  }
})();

export const compileAngular = functions.https.onRequest({
  memory: "2GiB",
  timeoutSeconds: 60,
  maxInstances: 3,
  minInstances: 0, // No always-on cost
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const startTime = Date.now();
  const timings: Record<string, number> = {};

  try {
    const { code: inputCode } = req.body;

    if (!inputCode) {
      res.status(400).json({ error: 'Code is required' });
      return;
    }

    timings.setup = Date.now() - startTime;

    // Generate cache key from code hash
    const codeHash = crypto.createHash('md5').update(inputCode.trim()).digest('hex');
    timings.hashing = Date.now() - startTime - timings.setup;

    // Check cache first
    const cachedResult = getCachedCompilation(codeHash);
    timings.cacheCheck = Date.now() - startTime - timings.setup - timings.hashing;

    if (cachedResult) {
      res.status(200).json({
        ...cachedResult,
        compilationTime: Date.now() - startTime,
        fromCache: true,
        timings
      });
      return;
    }

    let compiledCode = '';

    // Create thread-safe optimized host with cached module resolution
    const host = createOptimizedHost(inputCode, VIRTUAL_FILE, sharedCompilerOptions);

    // Override writeFile to capture compiled output for this specific request
    host.writeFile = (_: string, content: string) => {
      compiledCode = content;
    };

    // Add performance logging for host creation
    timings.hostCreation = Date.now() - startTime - timings.setup - timings.hashing - timings.cacheCheck;

    // Merge TS options with Angular compiler options for strict template checking (typed)
    const ngCompilerOptions: ts.CompilerOptions & NgcCompilerOptions = {
      ...sharedCompilerOptions,
      ...angularCompilerOptions,
    } as ts.CompilerOptions & NgcCompilerOptions;

    // Create NgProgram with optimized host (module resolution is cached internally)
    const ngProgram = new NgtscProgram([VIRTUAL_FILE], ngCompilerOptions, host);
    timings.programCreation = Date.now() - startTime - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    // CRITICAL: Force template type checking by analyzing the program
    // This ensures Template Type Check blocks (TCBs) are generated
    await ngProgram.compiler.analyzeAsync();

    // Force template diagnostics generation by accessing template type checker
    const compiler = ngProgram.compiler as any;
    if (compiler.ensureAllShimsForAllFiles) {
      compiler.ensureAllShimsForAllFiles();
    }
    timings.analysis = Date.now() - startTime - timings.programCreation - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    // Gather all diagnostics including Angular template type-checking
    const tsProgram = ngProgram.getTsProgram();
    const sourceFile = tsProgram.getSourceFile(VIRTUAL_FILE);
    const syntacticDiagnostics = tsProgram.getSyntacticDiagnostics();
    const semanticDiagnostics = tsProgram.getSemanticDiagnostics();
    const optionsDiagnostics = tsProgram.getOptionsDiagnostics();
    const ngStructuralDiagnostics = ngProgram.getNgStructuralDiagnostics?.() ?? [];
    const ngSemanticDiagnostics = sourceFile && typeof ngProgram.getNgSemanticDiagnostics === 'function'
      ? (ngProgram.getNgSemanticDiagnostics(sourceFile.fileName) as ts.Diagnostic[])
      : (ngProgram.getNgSemanticDiagnostics?.() as ts.Diagnostic[] | undefined) ?? [];

    const allDiagnostics: ts.Diagnostic[] = [
      ...syntacticDiagnostics,
      ...semanticDiagnostics,
      ...optionsDiagnostics,
      ...ngStructuralDiagnostics,
      ...ngSemanticDiagnostics,
    ];

    if (allDiagnostics.length > 0) {
      const diagnosticText = allDiagnostics
        .map((d: ts.Diagnostic) => {
          const fileName = d.file?.fileName || 'main.ts';
          const { line, character } =
            d.file && d.start !== undefined
              ? d.file.getLineAndCharacterOfPosition(d.start)
              : { line: 0, character: 0 };

          const category = ts.DiagnosticCategory[d.category] || 'Error';
          const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');

          return `${formatDiagnosticFilePath(fileName)}(${line + 1},${character + 1}): ${category} TS${d.code}: ${message}`;
        })
        .join('\n');

      const compilationTime = Date.now() - startTime;
      const errorResult: CompileResponse = {
        compiledOutput: diagnosticText,
        hasDiagnostics: true,
        compilationTime,
        fromCache: false,
        timings
      };

      cacheCompilation(codeHash, {
        compiledOutput: diagnosticText,
        hasDiagnostics: true
      });

      res.status(200).json(errorResult);
      return;
    }

    const { diagnostics: emitDiagnostics } = ngProgram.emit();
    timings.emission = Date.now() - startTime - timings.analysis - timings.programCreation - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    if (emitDiagnostics && emitDiagnostics.length > 0) {
      const diagnosticText = emitDiagnostics
        .map((d: ts.Diagnostic) => {
          const fileName = d.file?.fileName || 'main.ts';
          const { line, character } =
            d.file && d.start !== undefined
              ? d.file.getLineAndCharacterOfPosition(d.start)
              : { line: 0, character: 0 };

          return `${formatDiagnosticFilePath(fileName)}(${line + 1},${character + 1}): ${ts.DiagnosticCategory[d.category]
            } TS${d.code}: ${ts.flattenDiagnosticMessageText(
              d.messageText,
              '\n'
            )}`;
        })
        .join('\n');

      const compilationTime = Date.now() - startTime;
      const emitErrorResult: CompileResponse = {
        compiledOutput: diagnosticText,
        hasDiagnostics: true,
        compilationTime,
        fromCache: false,
        timings
      };

      cacheCompilation(codeHash, {
        compiledOutput: diagnosticText,
        hasDiagnostics: true
      });

      res.status(200).json(emitErrorResult);
      return;
    }

    // Parallel processing: clean code and format simultaneously
    const cleanedCode = removeNgDevModeBlocks(compiledCode);

    // Use cached prettier options for better performance
    const prettierOptions = {
      parser: 'typescript' as const,
      semi: true,
      singleQuote: true,
      trailingComma: 'es5' as const,
      tabWidth: 2,
      useTabs: false,
      printWidth: 80,
      bracketSpacing: true,
      arrowParens: 'avoid' as const,
      endOfLine: 'lf' as const,
    };

    const formattedCode = await prettier.format(cleanedCode, prettierOptions);
    timings.formatting = Date.now() - startTime - timings.emission - timings.analysis - timings.programCreation - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    const compilationTime = Date.now() - startTime;
    const result: CompileResponse = {
      compiledOutput: formattedCode,
      hasDiagnostics: false,
      compilationTime,
      fromCache: false,
      timings
    };

    // Cache the successful result
    cacheCompilation(codeHash, {
      compiledOutput: formattedCode,
      hasDiagnostics: false
    });

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({
      error: 'Internal server error',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

function removeNgDevModeBlocks(code: string): string {
  // Remove both ɵsetClassMetadata and ɵsetClassDebugInfo blocks
  return code.replace(
    /\(\(\) => \{ \(typeof ngDevMode === "undefined" \|\| ngDevMode\) && i\d+\.ɵsetClass(?:Metadata|DebugInfo)\([^;]+\); \}\)\(\);?\s*/g,
    ''
  );
}

// Shorten diagnostic file paths for readability, e.g., show "/main.ts" instead of full absolute path
function formatDiagnosticFilePath(fileName: string): string {
  try {
    const norm = fileName.replace(/\\/g, '/');
    const vNorm = VIRTUAL_FILE.replace(/\\/g, '/');

    // Always render the virtual entry file as /main.ts
    if (path.resolve(norm) === path.resolve(vNorm) || norm.endsWith('/main.ts') || norm === 'main.ts') {
      return '/main.ts';
    }

    const cwd = process.cwd().replace(/\\/g, '/');
    if (norm.startsWith(cwd)) {
      const rel = norm.slice(cwd.length);
      return rel.startsWith('/') ? rel : `/${rel}`;
    }

    // Fallback to just the basename with a leading slash
    return `/${path.basename(norm)}`;
  } catch {
    // On any unexpected error, fall back to a short name
    return `/${path.basename(fileName)}`;
  }
}