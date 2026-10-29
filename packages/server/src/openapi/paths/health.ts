/** Health and key discovery: the unauthenticated surface a load balancer and an SDK use on startup. */
import { ref } from "../schema";
import { op, type DocumentedOperation } from "../operation";

export const healthPaths: DocumentedOperation[] = [
  op("get", "/health", "Health", "getHealth", "Liveness check", {
    security: "none",
    description:
      "Answers 200 when the process is up, with the publishable key and the database in use so a client can check " +
      "that it is talking to the instance it expects. Intended for load balancers and container health checks.",
    success: { status: 200, schema: ref("Health") },
    errors: [],
  }),
];
