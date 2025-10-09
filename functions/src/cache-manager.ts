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
export const MODULE_RESOLUTION_TTL = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_CACHE_SIZE = 1000;

// Common Angular modules to pre-cache
export const COMMON_ANGULAR_MODULES = [
  '@angular/core',
  '@angular/common',
  '@angular/platform-browser',
  '@angular/forms',
  '@angular/router',
  '@angular/animations',
  'typescript',
  'rxjs'
];

// Cache instances
const enhancedModuleCache = new Map<string, EnhancedModuleCache>();
const modulePathCache = new Map<string, string>();
const fileContentCache = new Map<string, string>();
const compilationCache = new Map<string, CompileResponse>();

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
 * Check if a cached module is still valid (not expired)
 */
export const isCacheValid = (cachedModule: EnhancedModuleCache): boolean => {
  return Date.now() - cachedModule.timestamp < MODULE_RESOLUTION_TTL;
};

/**
 * Get module from enhanced cache
 */
export const getEnhancedCachedModule = (cacheKey: string): EnhancedModuleCache | undefined => {
  return enhancedModuleCache.get(cacheKey);
};

/**
 * Get module from legacy cache
 */
export const getLegacyCachedModule = (cacheKey: string): string | undefined => {
  return modulePathCache.get(cacheKey);
};

/**
 * Cache a resolved module in both enhanced and legacy caches
 */
export const cacheResolvedModule = (
  cacheKey: string, 
  resolvedModule: ts.ResolvedModule
): void => {
  // Cache in enhanced cache
  enhancedModuleCache.set(cacheKey, {
    resolvedFileName: resolvedModule.resolvedFileName,
    isExternalLibraryImport: resolvedModule.isExternalLibraryImport ?? true,
    timestamp: Date.now()
  });
  
  // Also maintain legacy cache for compatibility
  modulePathCache.set(cacheKey, resolvedModule.resolvedFileName);
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
 * Cache file content
 */
export const cacheFileContent = (fileName: string, content: string): void => {
  if (fileName.includes('node_modules')) {
    // Cache node_modules files since they don't change
    fileContentCache.set(fileName, content);
  }
};

/**
 * Get compilation result from cache
 */
export const getCachedCompilation = (codeHash: string): CompileResponse | undefined => {
  return compilationCache.get(codeHash);
};

/**
 * Cache compilation result
 */
export const cacheCompilation = (codeHash: string, result: CompileResponse): void => {
  // Clean cache if it's getting too large
  if (compilationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = compilationCache.keys().next().value;
    if (firstKey) {
      compilationCache.delete(firstKey);
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
  functions.logger.info(`🚀 Pre-warmed ${preWarmedCount} modules in ${warmupTime}ms`);
};

/**
 * Get cache statistics for monitoring
 */
export const getCacheStats = () => {
  return {
    enhancedModuleCacheSize: enhancedModuleCache.size,
    legacyModuleCacheSize: modulePathCache.size,
    fileCacheSize: fileContentCache.size,
    compilationCacheSize: compilationCache.size
  };
};