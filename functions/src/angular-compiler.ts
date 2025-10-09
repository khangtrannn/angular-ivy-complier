import * as functions from 'firebase-functions';
import * as ts from 'typescript';
import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import * as path from 'path';
import * as fs from 'fs';
import * as prettier from 'prettier';
import * as crypto from 'crypto';

interface CompileResponse {
  compiledOutput: string;
  hasDiagnostics: boolean;
  compilationTime?: number;
  fromCache?: boolean;
}

// In-memory cache for compilation results
const compilationCache = new Map<string, CompileResponse>();
const MAX_CACHE_SIZE = 1000;

// Pre-computed module paths cache
const modulePathCache = new Map<string, string>();

// Shared file content cache
const fileContentCache = new Map<string, string>();

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

  try {
    const VIRTUAL_FILE = '/main.ts';
    const { code: inputCode } = req.body;

    if (!inputCode) {
      res.status(400).json({ error: 'Code is required' });
      return;
    }

    // Generate cache key from code hash
    const codeHash = crypto.createHash('md5').update(inputCode.trim()).digest('hex');
    
    // Check cache first
    if (compilationCache.has(codeHash)) {
      const cachedResult = compilationCache.get(codeHash)!;
      const compilationTime = Date.now() - startTime;
      
      res.status(200).json({
        ...cachedResult,
        compilationTime,
        fromCache: true
      });
      return;
    }

    // Clean cache if it's getting too large
    if (compilationCache.size >= MAX_CACHE_SIZE) {
      const firstKey = compilationCache.keys().next().value;
      if (firstKey) {
        compilationCache.delete(firstKey);
      }
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
        if (fileContentCache.has(fileName)) {
          return fileContentCache.get(fileName);
        }
        
        const content = ts.sys.readFile(fileName);
        if (content && fileName.includes('node_modules')) {
          // Cache node_modules files since they don't change
          fileContentCache.set(fileName, content);
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
        const resolvedModules: (ts.ResolvedModule | undefined)[] = [];

        for (const moduleName of moduleNames) {
          // Check cache first
          const cacheKey = `${moduleName}|${containingFile}`;
          if (modulePathCache.has(cacheKey)) {
            const cachedPath = modulePathCache.get(cacheKey);
            if (cachedPath) {
              resolvedModules.push({
                resolvedFileName: cachedPath,
                isExternalLibraryImport: true,
              });
              continue;
            }
          }

          const result = ts.resolveModuleName(
            moduleName,
            containingFile,
            options,
            {
              fileExists: (fileName: string) => {
                if (fileName.includes('node_modules')) {
                  return fs.existsSync(fileName);
                }
                return ts.sys.fileExists(fileName);
              },
              readFile: (fileName: string) => {
                return ts.sys.readFile(fileName);
              },
              directoryExists: (dirName: string) => {
                return ts.sys.directoryExists(dirName);
              },
              getDirectories: (dirName: string) => {
                return ts.sys.getDirectories(dirName);
              },
              realpath: ts.sys.realpath,
              getCurrentDirectory: () => process.cwd(),
            }
          );

          if (result.resolvedModule) {
            // Cache successful resolution
            modulePathCache.set(cacheKey, result.resolvedModule.resolvedFileName);
            resolvedModules.push(result.resolvedModule);
          } else {
            const modulePath = path.join(process.cwd(), 'node_modules', moduleName);
            const indexPath = path.join(modulePath, 'index.d.ts');
            const pkgJsonPath = path.join(modulePath, 'package.json');

            if (fs.existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
              const typesPath = pkgJson.types || pkgJson.typings;

              if (typesPath) {
                const resolvedPath = path.join(modulePath, typesPath);
                if (fs.existsSync(resolvedPath)) {
                  // Cache this resolution
                  modulePathCache.set(cacheKey, resolvedPath);
                  resolvedModules.push({
                    resolvedFileName: resolvedPath,
                    isExternalLibraryImport: true,
                  });
                  continue;
                }
              }
            }

            if (fs.existsSync(indexPath)) {
              // Cache this resolution
              modulePathCache.set(cacheKey, indexPath);
              resolvedModules.push({
                resolvedFileName: indexPath,
                isExternalLibraryImport: true,
              });
            } else {
              resolvedModules.push(undefined);
            }
          }
        }

        return resolvedModules;
      },
    };

    const ngProgram = new NgtscProgram([VIRTUAL_FILE], options, host);

    await ngProgram.compiler.analyzeAsync();

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
      compilationCache.set(codeHash, {
        compiledOutput: diagnosticText,
        hasDiagnostics: true
      });

      res.status(200).json(errorResult);
      return;
    }

    const { diagnostics: emitDiagnostics } = ngProgram.emit();

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
      compilationCache.set(codeHash, {
        compiledOutput: diagnosticText,
        hasDiagnostics: true
      });

      res.status(200).json(emitErrorResult);
      return;
    }

    console.log('Raw compiled code:', compiledCode);

    const formattedCode = await prettier.format(removeNgDevModeBlocks(compiledCode), {
      parser: 'typescript',
      semi: true,
      singleQuote: true,
      trailingComma: 'es5',
      tabWidth: 2,
      useTabs: false,
      printWidth: 80,
      bracketSpacing: true,
      arrowParens: 'avoid',
      endOfLine: 'lf',
    });

    const compilationTime = Date.now() - startTime;
    const result: CompileResponse = {
      compiledOutput: formattedCode,
      hasDiagnostics: false,
      compilationTime,
      fromCache: false
    };

    // Cache the successful result
    compilationCache.set(codeHash, {
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