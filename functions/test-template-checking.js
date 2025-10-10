const { compileAngular } = require('./lib/angular-compiler');

async function testComprehensiveTemplateChecking() {
  console.log('🧪 Comprehensive Template Type Checking Tests\n');

  const testCases = [
    {
      name: 'Undefined Property',
      code: `import { Component } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<div>{{ undefinedProp }}</div>',
})
export class TestComponent {}`,
      shouldFail: true,
      expectedError: 'Property \'undefinedProp\' does not exist on type \'TestComponent\'.'
    },
    {
      name: 'Undefined Method',
      code: `import { Component } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<button (click)="undefinedMethod()">Click</button>',
})
export class TestComponent {}`,
      shouldFail: true,
      expectedError: 'Property \'undefinedMethod\' does not exist on type \'TestComponent\'.'
    },
    {
      name: 'Wrong Property Type',
      code: `import { Component } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<div>{{ count.toUpperCase() }}</div>',
})
export class TestComponent {
  count = 42;
}`,
      shouldFail: true,
      expectedError: 'Property \'toUpperCase\' does not exist on type \'number\'.'
    },
    {
      name: 'Valid Template - Simple Property',
      code: `import { Component } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<div>{{ message }}</div>',
})
export class TestComponent {
  message = 'Hello World';
}`,
      shouldFail: false
    },
    {
      name: 'Valid Template - Signal',
      code: `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<div>{{ count() }}</div>',
})
export class TestComponent {
  count = signal(0);
}`,
      shouldFail: false
    },
    {
      name: 'Valid Template - Method Call',
      code: `import { Component } from '@angular/core';

@Component({
  selector: 'app-test',
  template: '<button (click)="onClick()">{{ getButtonText() }}</button>',
})
export class TestComponent {
  onClick() {
    console.log('Clicked!');
  }
  
  getButtonText() {
    return 'Click me';
  }
}`,
      shouldFail: false
    }
  ];

  let passedTests = 0;
  let totalTests = testCases.length;

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    console.log(`=== TEST ${i + 1}: ${testCase.name} ===`);
    
    try {
      const result = await runSingleTest(testCase.code);
      
      if (testCase.shouldFail) {
        if (result.hasDiagnostics) {
          const hasExpectedError = testCase.expectedError ? 
            result.compiledOutput.includes(testCase.expectedError) : true;
          
          if (hasExpectedError) {
            console.log('✅ PASS: Expected error caught');
            console.log(`   Error: ${result.compiledOutput.split('\\n').find(line => line.includes('Error TS'))?.trim()}`);
            passedTests++;
          } else {
            console.log('⚠️  PARTIAL: Error caught but not the expected one');
            console.log(`   Expected: ${testCase.expectedError}`);
            console.log(`   Got: ${result.compiledOutput}`);
          }
        } else {
          console.log('❌ FAIL: Expected error but compilation succeeded');
        }
      } else {
        if (result.hasDiagnostics) {
          console.log('❌ FAIL: Expected success but got error');
          console.log(`   Error: ${result.compiledOutput}`);
        } else {
          console.log('✅ PASS: Compilation succeeded as expected');
          passedTests++;
        }
      }
    } catch (error) {
      console.log(`💥 FAIL: Test threw exception: ${error.message}`);
    }
    
    console.log('');
  }

  console.log(`🏁 Test Results: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All tests passed! Template type checking is working correctly.');
  } else {
    console.log(`⚠️  ${totalTests - passedTests} test(s) failed. There may be issues with template type checking.`);
  }
}

async function runSingleTest(code) {
  return new Promise((resolve, reject) => {
    const mockReq = {
      method: 'POST',
      body: { code }
    };

    const mockRes = {
      statusCode: null,
      responseData: null,
      
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { 
        this.responseData = data;
        resolve(data);
        return this;
      },
      send(data) { resolve(data); return this; }
    };

    compileAngular(mockReq, mockRes).catch(reject);
  });
}

// Run the comprehensive test
testComprehensiveTemplateChecking().catch(console.error);
