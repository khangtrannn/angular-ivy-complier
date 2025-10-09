import * as functions from 'firebase-functions';
import * as ts from 'typescript';
import { NgtscProgram, readConfiguration } from '@angular/compiler-cli';
import * as path from 'path';
import * as fs from 'fs';
import * as prettier from 'prettier';

interface CompileResponse {
  compiledOutput: string;
  hasDiagnostics: boolean;
}

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

  try {
    const VIRTUAL_FILE = '/main.ts';
    const { code: inputCode } = req.body;

    if (!inputCode) {
      res.status(400).json({ error: 'Code is required' });
      return;
    }

    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      sourceMap: false
    };

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
        return ts.sys.readFile(fileName);
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
                  resolvedModules.push({
                    resolvedFileName: resolvedPath,
                    isExternalLibraryImport: true,
                  });
                  continue;
                }
              }
            }

            if (fs.existsSync(indexPath)) {
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

      res.status(200).json({
        compiledOutput: diagnosticText,
        hasDiagnostics: true,
      } as CompileResponse);
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

      res.status(200).json({
        compiledOutput: diagnosticText,
        hasDiagnostics: true,
      } as CompileResponse);
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

    res.status(200).json({
      compiledOutput: formattedCode,
      hasDiagnostics: false,
    } as CompileResponse);
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