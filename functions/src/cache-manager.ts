import * as ts from 'typescript';
import * as functions from 'firebase-functions';

// Enhanced module resolution cache with performance tracking
export interface EnhancedModuleCache {
  resolvedFileName: string;
  isExternalLibraryImport: boolean;
  timestamp: number;
}

export interface CompileResponse {
  compiledOutput: string;
  hasDiagnostics: boolean;
  compilationTime?: number;
  fromCache?: boolean;
  timings?: Record<string, number>;
}

// Cache configuration
export const MODULE_RESOLUTION_TTL = Infinity; // Cache modules permanently
export const MAX_CACHE_SIZE = 1000;

// Common Angular modules to pre-cache (prioritized by usage frequency)
export const COMMON_ANGULAR_MODULES = [
  '@angular/core', // Most critical - always needed
  'typescript', // TypeScript definitions
  '@angular/common', // Common directives
  '@angular/platform-browser', // Browser-specific features
  'rxjs', // Reactive programming
  // Removed less common modules to speed up pre-warming
];

// Cache instances
const enhancedModuleCache = new Map<string, EnhancedModuleCache>();
const modulePathCache = new Map<string, string>();
const fileContentCache = new Map<string, string>();
const compilationCache = new Map<string, CompileResponse>();

// TypeScript Program cache for reusing expensive compiler setup
export interface CachedTsProgram {
  program: ts.Program;
  host: ts.CompilerHost;
  options: ts.CompilerOptions;
  lastUsed: number;
}

const tsProgramCache = new Map<string, CachedTsProgram>();
const TS_PROGRAM_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Optimize cache key generation for better performance
 */
export const createCacheKey = (moduleName: string, containingFile: string): string => {
  // Use shorter keys for better performance
  const fileType = containingFile === '/main.ts' ? 'main' : 
                  containingFile.includes('node_modules') ? 'npm' : 'local';
  return `${moduleName}#${fileType}`;
};

/**
 * Get module from enhanced cache (thread-safe)
 */
export const getEnhancedCachedModule = (cacheKey: string): EnhancedModuleCache | undefined => {
  try {
    return enhancedModuleCache.get(cacheKey);
  } catch (error) {
    // Return undefined if cache access fails
    return undefined;
  }
};

/**
 * Get module from legacy cache
 */
export const getLegacyCachedModule = (cacheKey: string): string | undefined => {
  return modulePathCache.get(cacheKey);
};

// Track modules currently being resolved to prevent duplicate work
const resolvingModules = new Set<string>();

/**
 * Cache a resolved module in both enhanced and legacy caches (thread-safe)
 */
export const cacheResolvedModule = (
  cacheKey: string, 
  resolvedModule: ts.ResolvedModule
): void => {
  try {
    // Atomic cache update - create entry first, then set
    const enhancedEntry = {
      resolvedFileName: resolvedModule.resolvedFileName,
      isExternalLibraryImport: resolvedModule.isExternalLibraryImport ?? true,
      timestamp: Date.now()
    };
    
    // Cache in enhanced cache
    enhancedModuleCache.set(cacheKey, enhancedEntry);
    
    // Also maintain legacy cache for compatibility
    modulePathCache.set(cacheKey, resolvedModule.resolvedFileName);
  } finally {
    // Always remove from resolving set
    resolvingModules.delete(cacheKey);
  }
};

/**
 * Check if a module is currently being resolved
 */
const isModuleBeingResolved = (cacheKey: string): boolean => {
  return resolvingModules.has(cacheKey);
};

/**
 * Mark a module as being resolved
 */
const markModuleAsResolving = (cacheKey: string): boolean => {
  if (resolvingModules.has(cacheKey)) {
    return false; // Already being resolved
  }
  resolvingModules.add(cacheKey);
  return true; // Successfully marked as resolving
};

/**
 * Migrate legacy cache entry to enhanced cache
 */
export const migrateLegacyToEnhanced = (cacheKey: string, legacyPath: string): void => {
  const enhancedEntry: EnhancedModuleCache = {
    resolvedFileName: legacyPath,
    isExternalLibraryImport: true,
    timestamp: Date.now()
  };
  enhancedModuleCache.set(cacheKey, enhancedEntry);
};

/**
 * Get file content from cache
 */
export const getCachedFileContent = (fileName: string): string | undefined => {
  return fileContentCache.get(fileName);
};

/**
 * Cache file content (thread-safe)
 */
export const cacheFileContent = (fileName: string, content: string): void => {
  if (fileName.includes('node_modules') && content && content.length > 0) {
    // Only cache non-empty node_modules files since they don't change
    // Use defensive check to avoid caching undefined/empty content
    try {
      fileContentCache.set(fileName, content);
    } catch (error) {
      // Silently ignore cache errors to prevent breaking compilation
    }
  }
};

/**
 * Get compilation result from cache (thread-safe)
 */
export const getCachedCompilation = (codeHash: string): CompileResponse | undefined => {
  try {
    return compilationCache.get(codeHash);
  } catch (error) {
    // Return undefined if cache access fails
    return undefined;
  }
};

// Synchronization flag for cache cleanup
let isCleaningCompilationCache = false;

/**
 * Cache compilation result with thread-safe cleanup
 */
export const cacheCompilation = (codeHash: string, result: CompileResponse): void => {
  // Thread-safe cache cleanup
  if (compilationCache.size >= MAX_CACHE_SIZE && !isCleaningCompilationCache) {
    isCleaningCompilationCache = true;
    try {
      // Remove oldest entries (up to 10% of cache size)
      const entriesToRemove = Math.floor(MAX_CACHE_SIZE * 0.1);
      const iterator = compilationCache.keys();
      for (let i = 0; i < entriesToRemove; i++) {
        const nextKey = iterator.next().value;
        if (nextKey) {
          compilationCache.delete(nextKey);
        } else {
          break;
        }
      }
    } finally {
      isCleaningCompilationCache = false;
    }
  }
  
  compilationCache.set(codeHash, result);
};

/**
 * Pre-warm module cache with commonly used Angular modules
 */
export const preWarmModuleCache = async (sharedCompilerOptions: ts.CompilerOptions): Promise<void> => {
  const startTime = Date.now();
  let preWarmedCount = 0;
  
  for (const moduleName of COMMON_ANGULAR_MODULES) {
    try {
      const cacheKey = createCacheKey(moduleName, '/main.ts');
      
      // Skip if already cached
      if (enhancedModuleCache.has(cacheKey)) continue;
      
      const result = ts.resolveModuleName(
        moduleName,
        '/main.ts',
        sharedCompilerOptions,
        ts.sys
      );
      
      if (result.resolvedModule) {
        cacheResolvedModule(cacheKey, result.resolvedModule);
        preWarmedCount++;
      }
    } catch (error) {
      // Silently continue on pre-warming errors
      functions.logger.debug(`Pre-warming failed for ${moduleName}:`, error);
    }
  }
  
  const warmupTime = Date.now() - startTime;
  functions.logger.info(`� Pre-warmed ${preWarmedCount} modules in ${warmupTime}ms`);
  functions.logger.info(`�📊 Permanent module caching enabled`);
};

/**
 * Create a thread-safe host factory that reuses expensive parts
 */
export const createOptimizedHost = (inputCode: string, virtualFile: string, options: ts.CompilerOptions): ts.CompilerHost => {
  const host: ts.CompilerHost = {
    getDefaultLibFileName: (opts: ts.CompilerOptions) => {
      return ts.getDefaultLibFilePath(opts);
    },
    getCurrentDirectory: () => process.cwd(),
    getDirectories: (pathStr: string) => ts.sys.getDirectories(pathStr),
    directoryExists: (dirName: string) => ts.sys.directoryExists(dirName),
    fileExists: (fileName: string) => {
      if (fileName === virtualFile) return true;
      return ts.sys.fileExists(fileName);
    },
    readFile: (fileName: string) => {
      if (fileName === virtualFile) return inputCode;
      
      try {
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
      } catch (error) {
        // Fallback to direct file read if caching fails
        return ts.sys.readFile(fileName);
      }
    },
    getCanonicalFileName: (fileName: string) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    useCaseSensitiveFileNames: () => !!ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    writeFile: (_: string, content: string) => {
      // This will be overwritten per request
    },
    getSourceFile(fileName: string, languageVersion: ts.ScriptTarget): ts.SourceFile | undefined {
      if (fileName === virtualFile) {
        return ts.createSourceFile(fileName, inputCode, languageVersion, true);
      }

      const content = ts.sys.readFile(fileName);
      return content
        ? ts.createSourceFile(fileName, content, languageVersion, true)
        : undefined;
    },
    resolveModuleNames: createCachedModuleResolver(options)
  };

  return host;
};

/**
 * Fallback resolution for modules TypeScript can't resolve
 */
const fallbackResolveModule = (moduleName: string): ts.ResolvedModule | undefined => {
  try {
    const path = require('path');
    const fs = require('fs');
    
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

/**
 * Create a cached module resolver that's safe for concurrent use
 */
const createCachedModuleResolver = (options: ts.CompilerOptions) => {
  return (moduleNames: string[], containingFile: string): (ts.ResolvedModule | undefined)[] => {
    // Initialize with correct length and fill with undefined
    const resolvedModules: (ts.ResolvedModule | undefined)[] = new Array(moduleNames.length).fill(undefined);
    const toResolve: Array<{ index: number; moduleName: string; cacheKey: string }> = [];
    
    // Phase 1: Batch cache lookup for all modules
    for (let i = 0; i < moduleNames.length; i++) {
      const moduleName = moduleNames[i];
      const cacheKey = createCacheKey(moduleName, containingFile);
      
      // Check enhanced cache first
      const cachedModule = getEnhancedCachedModule(cacheKey);
      if (cachedModule) {
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
          ? require('fs').existsSync(fileName) 
          : ts.sys.fileExists(fileName),
        readFile: ts.sys.readFile,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        realpath: ts.sys.realpath,
        getCurrentDirectory: () => process.cwd(),
      };

      for (const { index, moduleName, cacheKey } of toResolve) {
        let resolvedModule: ts.ResolvedModule | undefined;

        // Check if someone else is already resolving this module
        if (!markModuleAsResolving(cacheKey)) {
          // Another request is resolving this, do a quick recheck of cache
          // In the unlikely event of concurrent resolution of the same module,
          // we'll just resolve it again (better than blocking)
          const recheckCached = getEnhancedCachedModule(cacheKey);
          if (recheckCached) {
            resolvedModules[index] = {
              resolvedFileName: recheckCached.resolvedFileName,
              isExternalLibraryImport: recheckCached.isExternalLibraryImport,
            };
            continue;
          }
          // If still not in cache, proceed with resolution anyway
        }

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
          // Cache the successful resolution (this also clears the resolving flag)
          cacheResolvedModule(cacheKey, resolvedModule);
        } else {
          // Clear resolving flag even if resolution failed
          resolvingModules.delete(cacheKey);
        }

        resolvedModules[index] = resolvedModule;
      }
    }

    return resolvedModules;
  };
};

/**
 * Get cache statistics for monitoring
 */
export const getCacheStats = () => {
  return {
    enhancedModuleCacheSize: enhancedModuleCache.size,
    legacyModuleCacheSize: modulePathCache.size,
    fileCacheSize: fileContentCache.size,
    compilationCacheSize: compilationCache.size,
    tsProgramCacheSize: tsProgramCache.size,
    totalCachedModules: enhancedModuleCache.size + modulePathCache.size,
    permanentCaching: MODULE_RESOLUTION_TTL === Infinity
  };
};