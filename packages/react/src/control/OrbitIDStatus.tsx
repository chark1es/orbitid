import { useContext } from "react";
import type { ReactNode } from "react";
import { useElementClasses } from "../appearance/useAppearance";
import { useLocalizations } from "../localization/useLocalizations";
import { StatusContext } from "../provider/contexts";

export interface OrbitIDLoadedProps {
  children?: ReactNode;
}

/** Renders `children` only after the instance has loaded successfully. */
export function OrbitIDLoaded({ children }: OrbitIDLoadedProps) {
  const { status } = useContext(StatusContext);
  return status === "ready" ? <>{children}</> : null;
}

export interface OrbitIDLoadingProps {
  children?: ReactNode;
}

/** Renders while the instance loads (`children`, or a localized loading placeholder). */
export function OrbitIDLoading({ children }: OrbitIDLoadingProps) {
  const { status } = useContext(StatusContext);
  const { t } = useLocalizations();
  const loader = useElementClasses("loader");
  if (status !== "loading") return null;
  return <>{children ?? <div className={loader("orbitid-loader")} role="status" aria-live="polite">{t("status.loading")}</div>}</>;
}

export interface OrbitIDFailedProps {
  children?: ReactNode;
}

/** Renders when `load()` failed (`children`, or a message plus a retry button). */
export function OrbitIDFailed({ children }: OrbitIDFailedProps) {
  const { status, error, retry } = useContext(StatusContext);
  const { t } = useLocalizations();
  if (status !== "error") return null;
  if (children) return <>{children}</>;
  return (
    <div className="orbitid-error" role="alert">
      <p>{error?.message ?? t("status.failed")}</p>
      <button type="button" onClick={retry}>
        {t("status.retry")}
      </button>
    </div>
  );
}
