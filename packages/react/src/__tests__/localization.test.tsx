import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ErrorCodes } from "@orbitid/shared";
import { de, enUS, es, fr } from "../localization";
import { createTranslator, getByPath, interpolate, mergeLocalization } from "../localization/translate";
import { useLocalizations } from "../localization/useLocalizations";
import { renderWithProvider } from "./helpers";

describe("localization", () => {
  it("covers every API error code", () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(getByPath(enUS, `unstable__errors.${code}`), code).toBeTruthy();
    }
  });

  it("interpolates {{vars}}, counts and literal fallbacks", () => {
    const t = createTranslator(enUS);
    expect(t("signIn.start.title", { applicationName: "Acme" })).toBe("Sign in to Acme");
    expect(t("paginationRowText__resultCount", 3)).toBe("3 result");
    expect(t("missing.path", "Literal fallback")).toBe("Literal fallback");
    expect(t("missing.path")).toBe("missing.path");
    expect(interpolate("{{a}}/{{ b }}/{{missing}}", { a: 1, b: "x" })).toBe("1/x/{{missing}}");
  });

  it("falls back to enUS for partially translated locales", () => {
    const german = createTranslator(de);
    expect(german("signIn.start.title", { applicationName: "Acme" })).toBe("Bei Acme anmelden");
    expect(german("userProfile.profilePage.title")).toBe(
      getByPath(enUS, "userProfile.profilePage.title"),
    );
    expect(createTranslator(fr)("formFieldLabel__emailAddress")).toBe("Adresse e-mail");
    expect(createTranslator(es)("formFieldLabel__emailAddress")).toBe("Correo electrónico");
    expect(mergeLocalization(enUS, de).locale).toBe("de-DE");
  });

  it("merges provider overrides over enUS and exposes the locale", () => {
    function Probe() {
      const { t, locale } = useLocalizations();
      return (
        <p data-testid="strings">
          {[locale, t("signIn.start.title", { applicationName: "Acme" }), t("formButtonPrimary")].join("|")}
        </p>
      );
    }

    renderWithProvider(<Probe />, {
      providerProps: { localization: { locale: "fr-FR", signIn: { start: { title: "Connexion à {{applicationName}}" } } } },
    });

    expect(screen.getByTestId("strings").textContent).toBe("fr-FR|Connexion à Acme|Continue");
  });

  it("keeps enUS when localization is disabled", () => {
    function Probe() {
      const { locale } = useLocalizations();
      return <p data-testid="locale">{locale}</p>;
    }
    renderWithProvider(<Probe />, { providerProps: { localization: false } });
    expect(screen.getByTestId("locale").textContent).toBe("en-US");
  });
});
