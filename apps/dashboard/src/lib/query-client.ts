import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

// 401s are handled once, inside `api`, which clears the key and signals the auth guard.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx responses are deliberate; retrying them just doubles the noise.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});
