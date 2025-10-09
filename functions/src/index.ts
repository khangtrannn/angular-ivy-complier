import { setGlobalOptions } from "firebase-functions";
setGlobalOptions({ maxInstances: 10 });

export { helloWorld } from "./hello-world";