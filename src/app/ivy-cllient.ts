import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";

export interface CompiledResponse {
  compiledCode: string;
  hasError: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class IvyClient {
  #http = inject(HttpClient);

  getCompiledCode(code: string) {
    return this.#http.post<CompiledResponse>('/api/compiled-code', { code });
  }
}