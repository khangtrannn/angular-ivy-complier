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
  
  constructor() {
    this.compileCode(this.inputCode());
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
      
      // Wait for fade-out animation to complete before starting stream
      setTimeout(() => {
        this.compiledCode.set(result.compiledOutput);
        this.hasDiagnostics.set(result.hasDiagnostics);
        this.isCompiling.set(false);
        
        // Count lines and start streaming effect
        const lines = result.compiledOutput.split('\n');
        this.totalLines.set(lines.length);
        this.startTypewriterEffect(lines.length);
      }, 300); // Match CSS transition duration
      
    } catch (error: any) {
      this.isSkeletonFadingOut.set(true);
      setTimeout(() => {
        this.compilationError.set(error.message || 'Compilation failed');
        this.isCompiling.set(false);
      }, 300);
    }
  }

  private startTypewriterEffect(totalLines: number) {
    this.isStreaming.set(true);
    this.streamingProgress.set(0);
    
    let currentLine = 0;
    
    const revealNextLine = () => {
      if (currentLine < totalLines) {
        currentLine++;
        this.streamingProgress.set((currentLine / totalLines) * 100);
        
        // Base delay of 80ms per line, with some variation
        const delay = 60 + Math.random() * 40; // 60-100ms
        
        setTimeout(revealNextLine, delay);
      } else {
        // Streaming complete
        setTimeout(() => {
          this.isStreaming.set(false);
        }, 500); // Brief pause before switching to full editor
      }
    };
    
    // Start revealing after a short delay
    setTimeout(revealNextLine, 100);
  }

  protected selectTemplate(event: Event) {
    const template = (event.target as HTMLSelectElement).value;
    this.inputCode.set(this.templates[template as keyof typeof this.templates]);
  }
}
