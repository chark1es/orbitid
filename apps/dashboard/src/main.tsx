import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, initTheme } from "@orbitid/ui";
import App from "./App";
import { DashboardToaster } from "./components/layout/dashboard-toaster";
import { AuthProvider } from "./lib/auth";
import { queryClient } from "./lib/query-client";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

// Apply the stored theme before the first paint. Doing this outside React keeps an inline script out
// of the component tree, which React 19 rejects when it renders a <script> element.
initTheme();

createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="orbitid-theme">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
            <DashboardToaster />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
