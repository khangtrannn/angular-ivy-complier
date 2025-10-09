import { Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { NgTemplateOutlet } from '@angular/common';
import { CodeMirrorDirective } from './codemirror.directive';
import { IvyClient } from './ivy-cllient';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CodeMirrorDirective, NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
})
export class App {
  #ivyClient = inject(IvyClient);

  protected readonly templates = {
    basic: `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: '<h1>{{ title() }}</h1>',
})
export class App {
  title = signal('Hello Angular');
}`,
  };

  protected readonly inputCode = signal(this.templates.basic);
  protected readonly compilationError = signal<string | null>(null);
  protected readonly compiledCode = signal<string>('');
  protected readonly hasDiagnostics = signal(false);
  protected readonly isCompiling = signal(false);
  protected readonly isSkeletonFadingOut = signal(false);
  protected readonly isStreaming = signal(false);
  protected readonly streamingProgress = signal(0); // Percentage of lines revealed
  protected readonly totalLines = signal(0);
  protected readonly compilationTime = signal<number | null>(null);
  protected readonly fromCache = signal<boolean>(false);

  // Debounce compilation to avoid excessive API calls
  #compileTimeout: number | null = null;
  
  constructor() {
    this.compileCode(this.inputCode());
  }

  compileCodeDebounced(code: string, delay = 300) {
    if (this.#compileTimeout) {
      clearTimeout(this.#compileTimeout);
    }
    
    this.#compileTimeout = setTimeout(() => {
      this.compileCode(code);
    }, delay);
  }

  async compileCode(code: string) {
    try {
      this.isCompiling.set(true);
      this.isSkeletonFadingOut.set(false);
      this.isStreaming.set(false);
      this.streamingProgress.set(0);
      this.compilationError.set(null);
      
      const result = await firstValueFrom(this.#ivyClient.getCompiledOutput(code));
      
      this.isSkeletonFadingOut.set(true);
      
      // Always use the same animation timing for consistent UX
      // Whether from cache or fresh compilation
      setTimeout(() => {
        this.compiledCode.set(result.compiledOutput);
        this.hasDiagnostics.set(result.hasDiagnostics);
        this.compilationTime.set(result.compilationTime);
        this.fromCache.set(result.fromCache || false);
        this.isCompiling.set(false);
        
        // Count lines and start streaming effect
        const lines = result.compiledOutput.split('\n');
        this.totalLines.set(lines.length);
        
        // Use faster animation for cached results but still smooth
        const isCached = result.fromCache || false;
        this.startTypewriterEffect(lines.length, isCached);
      }, 300); // Match CSS transition duration
      
    } catch (error: any) {
      this.isSkeletonFadingOut.set(true);
      setTimeout(() => {
        this.compilationError.set(error.message || 'Compilation failed');
        this.compilationTime.set(null);
        this.fromCache.set(false);
        this.isCompiling.set(false);
      }, 300);
    }
  }

  private startTypewriterEffect(totalLines: number, isCached: boolean = false) {
    this.isStreaming.set(true);
    this.streamingProgress.set(0);
    
    let currentLine = 0;
    
    const revealNextLine = () => {
      if (currentLine < totalLines) {
        currentLine++;
        this.streamingProgress.set((currentLine / totalLines) * 100);
        
        // Faster animation for cached results, but still smooth
        const baseDelay = isCached ? 30 : 60; // Cached: 30-50ms, Fresh: 60-100ms
        const variation = isCached ? 20 : 40;
        const delay = baseDelay + Math.random() * variation;
        
        setTimeout(revealNextLine, delay);
      } else {
        // Streaming complete
        setTimeout(() => {
          this.isStreaming.set(false);
        }, isCached ? 300 : 500); // Shorter pause for cached results
      }
    };
    
    // Start revealing after a short delay (faster for cached)
    setTimeout(revealNextLine, isCached ? 50 : 100);
  }

  protected selectTemplate(event: Event) {
    const template = (event.target as HTMLSelectElement).value;
    this.inputCode.set(this.templates[template as keyof typeof this.templates]);
  }
}
