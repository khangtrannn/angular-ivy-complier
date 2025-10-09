import { onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import cors from "cors";

const corsHandler = cors({ origin: true });

export const helloWorld = onRequest((request, response) => {
  return corsHandler(request, response, () => {
    logger.info("Hello World function called", { structuredData: true });
    
    response.json({
      message: "Hello from Firebase Functions!",
      timestamp: new Date().toISOString(),
      method: request.method,
    });
  });
});