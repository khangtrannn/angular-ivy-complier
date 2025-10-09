import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { map, timeout, catchError } from "rxjs/operators";
import { throwError } from "rxjs";

export interface CompiledResponse {
  compiledOutput: string;
  hasDiagnostics: boolean;
  compilationTime: number;
  fromCache?: boolean;
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
        'Content-Type': 'application/json',
        'Connection': 'keep-alive', // Reuse connections
      },
      // Add timeout for better UX
      observe: 'response'
    }).pipe(
      map(response => response.body as CompiledResponse),
      timeout(30000), // 30 second timeout
      catchError((error: any) => {
        console.error('Compilation error:', error);
        return throwError(() => error);
      })
    );
  }
}