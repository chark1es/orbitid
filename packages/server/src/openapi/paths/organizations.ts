/** Organization routes: Frontend API (`/v1/client/me/*`, `/v1/client/organizations/*`) and Backend API (`/v1/organizations/*`). */
import type { DocumentedOperation } from "../operation";
import { operations as clientOperations } from "./organizations/client";
import { operations as backendOperations } from "./organizations/backend";
import { operations as roleOperations } from "./organizations/roles";

export const organizationPaths: DocumentedOperation[] = [...clientOperations, ...backendOperations, ...roleOperations];
