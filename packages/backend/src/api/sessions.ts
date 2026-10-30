import type { BackendHttp } from "../http";
import type { Client, ListParams, Session, SessionToken } from "../types";
import { list } from "./shared";

export interface SessionListParams extends ListParams {
  clientId?: string;
  userId?: string;
  status?: string;
}

export function createSessionsApi(http: BackendHttp) {
  return {
    getSessionList(params: SessionListParams = {}) {
      return list<Session>(http, "/v1/sessions", {
        client_id: params.clientId,
        user_id: params.userId,
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      });
    },
    getSession(sessionId: string) {
      return http.get<Session>(`/v1/sessions/${sessionId}`);
    },
    revokeSession(sessionId: string) {
      return http.post<Session>(`/v1/sessions/${sessionId}/revoke`);
    },
    /**
     * Mints a session JWT for `sessionId`. The server requires the caller to prove it holds that session's own
     * token (`sessionToken`), sent as `X-OrbitID-Session-Token`; a secret key alone cannot mint a user's session.
     */
    getToken(sessionId: string, params: { template?: string; sessionToken?: string } = {}) {
      const path = params.template ? `/v1/sessions/${sessionId}/tokens/${encodeURIComponent(params.template)}` : `/v1/sessions/${sessionId}/tokens`;
      return http.post<SessionToken>(path, { headers: params.sessionToken ? { "X-OrbitID-Session-Token": params.sessionToken } : {} });
    },
  };
}

export function createClientsApi(http: BackendHttp) {
  return {
    getClient(clientId: string) {
      return http.get<Client>(`/v1/clients/${clientId}`);
    },
    verifyClient(params: { token: string }) {
      return http.post<Client>("/v1/clients/verify", { body: params });
    },
  };
}
