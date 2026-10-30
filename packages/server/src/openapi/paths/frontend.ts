/** Frontend API: environment, sign-in/up, the signed-in user, client/session state, public assets, waitlist and SSO. */
import type { DocumentedOperation } from "../operation";
import { operations as authOperations } from "./frontend/auth";
import { operations as meOperations } from "./frontend/me";
import { operations as clientOperations } from "./frontend/client";

export const frontendPaths: DocumentedOperation[] = [...authOperations, ...meOperations, ...clientOperations];
