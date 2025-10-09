import { Directive, ElementRef, OnInit, effect, inject, input } from '@angular/core';
import { EditorView, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { githubDark } from '@uiw/codemirror-theme-github';
import { javascript } from '@codemirror/lang-javascript';
import { minimalSetup } from 'codemirror';
import { Compartment } from '@codemirror/state';

@Directive({
  selector: '[appCodeMirror]',
  standalone: true,
  exportAs: 'appCodeMirror',
})
export class CodeMirrorDirective implements OnInit {
  #editor!: EditorView;
  #elementRef = inject(ElementRef);

  content = input.required<string>();
  hasDiagnostics = input<boolean>(false);
  isCodeEditor = input<boolean>(false);

  #language = new Compartment();
  #activeLineHighlight = new Compartment();

  constructor() {
    effect(() => {
      if (!this.#editor) return;

      this.#editor.dispatch({
        changes: { from: 0, to: this.#editor.state.doc.length, insert: this.content() },
      });

      this.#editor.dispatch({
        effects: this.#language.reconfigure(this.hasDiagnostics() ? [] : javascript()),
      });
    });
  }

  ngOnInit(): void {
    const extensions = [
      minimalSetup,
      githubDark,
      EditorView.lineWrapping,
      this.#language.of(javascript()),
      EditorView.theme({
        '&': {
          fontSize: '12.5px',
          height: 'calc(100vh - 125px)',
        },
        '&.cm-focused': {
          outline: 'none',
        },
        '.cm-gutter': {
          minWidth: '24px',
        },
        '.cm-scroller': {
          fontFamily: "'SF Mono', Monaco, Menlo, Consolas, 'Ubuntu Mono', monospace",
          lineHeight: '20px',
        },
        '.cm-content': {
          padding: '8px 0',
        },
        ".cm-foldGutter": { display: "none" },
        ".cm-gutterElement": { pointerEvents: "none" },
      }),
    ];

    if (this.isCodeEditor()) {
      extensions.push(lineNumbers());
      extensions.push(this.#activeLineHighlight.of([]));

      extensions.push(EditorView.domEventHandlers({
        focus: (_, view) => {
          view.dispatch({
            effects: this.#activeLineHighlight.reconfigure(highlightActiveLine())
          });
        },
      }));
    }

    this.#editor = new EditorView({
      extensions,
      parent: this.#elementRef.nativeElement,
    });
  }

  get doc() {
    return this.#editor.state.doc.toString();
  }
}
