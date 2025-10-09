import * as functions from 'firebase-functions';
import * as ts from 'typescript';
import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import * as path from 'path';
import * as fs from 'fs';
import * as prettier from 'prettier';
import * as crypto from 'crypto';
import {
  CompileResponse,
  createCacheKey,
  isCacheValid,
  getEnhancedCachedModule,
  getLegacyCachedModule,
  cacheResolvedModule,
  migrateLegacyToEnhanced,
  getCachedFileContent,
  cacheFileContent,
  getCachedCompilation,
  cacheCompilation,
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

export const compileAngular = functions.https.onRequest(async (req, res) => {
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

    const host: ts.CompilerHost = {
      getDefaultLibFileName: (opts: ts.CompilerOptions) => {
        return ts.getDefaultLibFilePath(opts);
      },
      getCurrentDirectory: () => process.cwd(),
      getDirectories: (pathStr: string) => ts.sys.getDirectories(pathStr),
      directoryExists: (dirName: string) => ts.sys.directoryExists(dirName),
      fileExists: (fileName: string) => {
        if (fileName === VIRTUAL_FILE) return true;
        return ts.sys.fileExists(fileName);
      },
      readFile: (fileName: string) => {
        if (fileName === VIRTUAL_FILE) return inputCode;
        
        // Cache file reads for better performance
        const cachedContent = getCachedFileContent(fileName);
        if (cachedContent) {
          return cachedContent;
        }
        
        const content = ts.sys.readFile(fileName);
        if (content) {
          cacheFileContent(fileName, content);
        }
        return content;
      },
      getCanonicalFileName: (fileName: string) =>
        ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
      useCaseSensitiveFileNames: () => !!ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
      writeFile: (_: string, content: string) => {
        compiledCode = content;
      },
      getSourceFile(fileName: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
        if (fileName === VIRTUAL_FILE) {
          return ts.createSourceFile(fileName, inputCode, languageVersion, true);
        }

        const content = ts.sys.readFile(fileName);
        return content
          ? ts.createSourceFile(fileName, content, languageVersion, true)
          : undefined;
      },
      resolveModuleNames(
        moduleNames: string[],
        containingFile: string
      ): (ts.ResolvedModule | undefined)[] {
        // Initialize with correct length and fill with undefined
        const resolvedModules: (ts.ResolvedModule | undefined)[] = new Array(moduleNames.length).fill(undefined);
        const toResolve: Array<{ index: number; moduleName: string; cacheKey: string }> = [];
        
        // Phase 1: Batch cache lookup for all modules
        for (let i = 0; i < moduleNames.length; i++) {
          const moduleName = moduleNames[i];
          const cacheKey = createCacheKey(moduleName, containingFile);
          
          // Check enhanced cache first
          const cachedModule = getEnhancedCachedModule(cacheKey);
          if (cachedModule && isCacheValid(cachedModule)) {
            resolvedModules[i] = {
              resolvedFileName: cachedModule.resolvedFileName,
              isExternalLibraryImport: cachedModule.isExternalLibraryImport,
            };
            continue;
          }
          
          // Check legacy cache
          const legacyCachedPath = getLegacyCachedModule(cacheKey);
          if (legacyCachedPath) {
            // Migrate to enhanced cache
            migrateLegacyToEnhanced(cacheKey, legacyCachedPath);
            
            resolvedModules[i] = {
              resolvedFileName: legacyCachedPath,
              isExternalLibraryImport: true,
            };
            continue;
          }
          
          // Mark for resolution
          toResolve.push({ index: i, moduleName, cacheKey });
        }

        // Phase 2: Batch resolve uncached modules
        if (toResolve.length > 0) {
          // Create shared resolution host to avoid recreation overhead
          const resolutionHost = {
            fileExists: (fileName: string) => fileName.includes('node_modules') 
              ? fs.existsSync(fileName) 
              : ts.sys.fileExists(fileName),
            readFile: ts.sys.readFile,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
            getCurrentDirectory: () => process.cwd(),
          };

          for (const { index, moduleName, cacheKey } of toResolve) {
            let resolvedModule: ts.ResolvedModule | undefined;

            try {
              const result = ts.resolveModuleName(moduleName, containingFile, options, resolutionHost);
              resolvedModule = result.resolvedModule;
            } catch (error) {
              // Fallback resolution on error
              resolvedModule = fallbackResolveModule(moduleName);
            }

            // Try fallback if TypeScript resolution failed
            if (!resolvedModule) {
              resolvedModule = fallbackResolveModule(moduleName);
            }

            if (resolvedModule) {
              // Cache the successful resolution
              cacheResolvedModule(cacheKey, resolvedModule);
            }

            resolvedModules[index] = resolvedModule;
          }
        }

        return resolvedModules;
      },
    };

    // Fallback resolution for modules TypeScript can't resolve
    const fallbackResolveModule = (moduleName: string): ts.ResolvedModule | undefined => {
      try {
        const modulePath = path.join(process.cwd(), 'node_modules', moduleName);
        
        // Check if the module directory exists first
        if (!fs.existsSync(modulePath)) {
          return undefined;
        }
        
        const pkgJsonPath = path.join(modulePath, 'package.json');
        
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          
          // Try multiple resolution paths in order of preference
          const candidates = [
            pkgJson.types,
            pkgJson.typings,
            pkgJson.main,
            'index.d.ts',
            'lib/index.d.ts',
            'dist/index.d.ts'
          ].filter(Boolean);
          
          for (const candidate of candidates) {
            const resolvedPath = path.join(modulePath, candidate);
            if (fs.existsSync(resolvedPath)) {
              return {
                resolvedFileName: resolvedPath,
                isExternalLibraryImport: true,
              };
            }
          }
        }
        
        // Final fallback: try common patterns
        const fallbackPaths = [
          path.join(modulePath, 'index.d.ts'),
          path.join(modulePath, 'index.ts'),
          path.join(modulePath, 'lib', 'index.d.ts'),
          path.join(modulePath, 'dist', 'index.d.ts')
        ];
        
        for (const fallbackPath of fallbackPaths) {
          if (fs.existsSync(fallbackPath)) {
            return {
              resolvedFileName: fallbackPath,
              isExternalLibraryImport: true,
            };
          }
        }
        
      } catch (error) {
        // Silent fallback failure
      }
      
      return undefined;
    };

    timings.hostCreation = Date.now() - startTime - timings.setup - timings.hashing - timings.cacheCheck;
    
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
        fromCache: false
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
        fromCache: false
      };

      // Cache emit error results too (second error case)
      cacheCompilation(codeHash, {
        compiledOutput: diagnosticText,
        hasDiagnostics: true
      });

      res.status(200).json(emitErrorResult);
      return;
    }

    console.log('Raw compiled code:', compiledCode);

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