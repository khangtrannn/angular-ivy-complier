import { setGlobalOptions } from "firebase-functions";

// Optimize for performance and reduce cold starts
setGlobalOptions({ 
  maxInstances: 10,
  memory: "1GiB", // More memory for faster compilation
  timeoutSeconds: 60,
  minInstances: 1 // Keep at least one warm instance
});

export { compileAngular } from "./angular-compiler";