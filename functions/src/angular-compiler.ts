import { NgtscProgram } from '@angular/compiler-cli';
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

// Reusable compiler options
const sharedCompilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  sourceMap: false,
  // Performance optimizations
  isolatedModules: true,
  assumeChangesOnlyAffectDirectDependencies: true,
  disableSourceOfProjectReferenceRedirect: true,
  // Skip unnecessary checks for faster compilation
  noResolve: false, // Keep this false for Angular imports
  noImplicitAny: false, // Allow implicit any for faster compilation
  noImplicitReturns: false // Skip strict return checking
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
  memory: "1GiB", // Sufficient for compilation
  timeoutSeconds: 60,
  maxInstances: 3, // Limit costs
  minInstances: 0, // No always-on cost
}, async (req, res) => {
  // Enable CORS
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
    const VIRTUAL_FILE = '/main.ts';
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
      const compilationTime = Date.now() - startTime;
      
      // Log cache hit for monitoring
      functions.logger.info(`Cache hit in ${compilationTime}ms`, {
        fromCache: true,
        timings,
        codeLength: inputCode.length
      });
      
      res.status(200).json({
        ...cachedResult,
        compilationTime,
        fromCache: true,
        timings
      });
      return;
    }

    const options = sharedCompilerOptions;

    let compiledCode = '';

    // Create thread-safe optimized host with cached module resolution
    const host = createOptimizedHost(inputCode, VIRTUAL_FILE, options);
    
    // Override writeFile to capture compiled output for this specific request
    host.writeFile = (_: string, content: string) => {
      compiledCode = content;
    };
    
    // Add performance logging for host creation
    functions.logger.debug(`Host created in ${timings.hostCreation}ms`);

    timings.hostCreation = Date.now() - startTime - timings.setup - timings.hashing - timings.cacheCheck;
    
    // Create NgProgram with optimized host (module resolution is cached internally)
    const ngProgram = new NgtscProgram([VIRTUAL_FILE], options, host);
    timings.programCreation = Date.now() - startTime - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    await ngProgram.compiler.analyzeAsync();
    timings.analysis = Date.now() - startTime - timings.programCreation - timings.hostCreation - timings.cacheCheck - timings.hashing - timings.setup;

    const allDiagnostics: ts.Diagnostic[] = [
      ...ngProgram.getTsProgram().getSyntacticDiagnostics(),
      ...ngProgram.getTsProgram().getSemanticDiagnostics(),
      ...ngProgram.getTsProgram().getOptionsDiagnostics(),
      ...(ngProgram.getNgStructuralDiagnostics?.() ?? []),
      ...(ngProgram.getNgSemanticDiagnostics?.() ?? []),
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

          return `${fileName}(${line + 1},${character + 1}): ${category} TS${d.code}: ${message}`;
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

      // Cache error results too (first error case)
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

          return `${fileName}(${line + 1},${character + 1}): ${ts.DiagnosticCategory[d.category]
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

      // Cache emit error results too (second error case)
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

    // Log performance metrics for monitoring
    functions.logger.info(`Compilation completed in ${compilationTime}ms`, {
      fromCache: false,
      timings,
      codeLength: inputCode.length,
      outputLength: formattedCode.length
    });

    res.status(200).json(result);
  } catch (err) {
    functions.logger.error('Compilation error:', err);
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