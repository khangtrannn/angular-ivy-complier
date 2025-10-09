import { setGlobalOptions } from "firebase-functions";

// Cost-optimized configuration for demo usage
setGlobalOptions({ 
  maxInstances: 3, // Limit concurrent instances to control costs
  memory: "2GiB", // Balanced performance and cost
  timeoutSeconds: 60,
  minInstances: 0, // No always-on instances to minimize cost
});

export { compileAngular } from "./angular-compiler";