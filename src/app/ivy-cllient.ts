import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { of } from "rxjs";

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
    return of({ compiledCode: '', hasError: false });
    // return this.#http.post<CompiledResponse>(functionUrl, { 
    //   code,
    // }, {
    //   headers: {
    //     'Content-Type': 'application/json'
    //   }
    // });
  }
}