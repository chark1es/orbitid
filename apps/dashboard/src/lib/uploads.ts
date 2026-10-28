import { ApiError, getApiUrl, getSecretKey } from "./api";

async function parseError(res: Response): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  let code = "unknown";
  let message = res.statusText;
  if (body && typeof body === "object" && "errors" in body && Array.isArray(body.errors)) {
    const first: unknown = body.errors[0];
    if (first && typeof first === "object") {
      if ("code" in first && typeof first.code === "string") code = first.code;
      if ("long_message" in first && typeof first.long_message === "string") message = first.long_message;
      else if ("message" in first && typeof first.message === "string") message = first.message;
    }
  }
  return new ApiError(res.status, code, message);
}

/** Multipart upload against the Backend API (JSON-only `api()` cannot carry files). */
export async function uploadFile<T>(path: string, method: "POST" | "PUT", file: File, field = "file"): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  const res = await fetch(`${getApiUrl()}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${getSecretKey()}` },
    body: form,
  });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json();
  return body as T;
}

export const uploadProfileImage = <T>(userId: string, file: File) =>
  uploadFile<T>(`/users/${userId}/profile_image`, "POST", file);

export const uploadOrganizationLogo = <T>(orgId: string, file: File) =>
  uploadFile<T>(`/organizations/${orgId}/logo`, "PUT", file);
