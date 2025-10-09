import { setGlobalOptions } from "firebase-functions";
setGlobalOptions({ maxInstances: 10 });

export { compileAngular } from "./angular-compiler";