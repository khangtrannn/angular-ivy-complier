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
  #URL = 'https://us-central1-mktrannblog.cloudfunctions.net/compileAngular';
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