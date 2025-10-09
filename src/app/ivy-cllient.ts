import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";

export interface CompiledResponse {
  compiledOutput: string;
  hasDiagnostics: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class IvyClient {
  #URL = 'http://127.0.0.1:5001/mktrannblog/us-central1/compileAngular';
  #http = inject(HttpClient);

  getCompiledOutput(code: string) {
    return this.#http.post<CompiledResponse>(this.#URL, {
      code,
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}