/** Backend API: users, identifiers, sessions, clients, tokens, JWT templates, instance, invitations, waitlist. */
import type { DocumentedOperation } from "../operation";
import { operations as userOperations } from "./backend/users";
import { operations as sessionOperations } from "./backend/sessions";
import { operations as instanceOperations } from "./backend/instance";

export const backendPaths: DocumentedOperation[] = [...userOperations, ...sessionOperations, ...instanceOperations];
