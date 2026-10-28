import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { StatusChip, type StatusKind } from "./status-chip";
import { SocialStartButton } from "./social-start";
import { countFeatureStatuses, STATUS_LABEL, type FeatureSection } from "@/lib/feature-matrix";

const CHIP_KIND: Record<string, StatusKind> = {
  enabled: "enabled",
  off: "off",
  "needs-config": "needs-config",
};

function Summary({ sections }: { sections: FeatureSection[] }) {
  const counts = countFeatureStatuses(sections);
  const total = counts.enabled + counts.off + counts["needs-config"];
  return (
    <p className="text-sm text-muted-foreground">
      {total} features read from the environment:{" "}
      <span className="text-go">{counts.enabled} enabled</span>,{" "}
      <span className="text-muted-foreground">{counts.off} off</span>,{" "}
      <span className="text-caution">
        {counts["needs-config"]} {counts["needs-config"] === 1 ? "needs config" : "need config"}
      </span>
      .
    </p>
  );
}

function FeatureTable({ section }: { section: FeatureSection }) {
  return (
    <section aria-labelledby={`matrix-${section.id}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`matrix-${section.id}`} className="text-base">
          {section.title}
        </h2>
        {section.hint ? <p className="text-xs text-muted-foreground">{section.hint}</p> : null}
      </div>
      <table className="w-full border-t text-sm">
        <caption className="sr-only">{section.title}</caption>
        <thead className="hidden sm:table-header-group">
          <tr className="border-b text-left">
            <th scope="col" className="w-[30%] py-2 pr-4 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Feature
            </th>
            <th scope="col" className="w-[15%] py-2 pr-4 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Status
            </th>
            <th scope="col" className="py-2 pr-4 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Detail
            </th>
            <th scope="col" className="w-[1%] py-2 text-right text-[0.6875rem] font-semibold tracking-[0.04em] whitespace-nowrap text-muted-foreground uppercase">
              Try it
            </th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row) => (
            <tr key={row.id} className="block border-b py-3 sm:table-row sm:py-0">
              <th scope="row" className="block text-left font-medium sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top">
                {row.label}
              </th>
              <td className="mt-1 block sm:mt-0 sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top">
                <StatusChip kind={CHIP_KIND[row.status] ?? "off"} label={STATUS_LABEL[row.status]} />
              </td>
              <td className="mt-1 block sm:mt-0 sm:table-cell sm:py-2.5 sm:pr-4 sm:align-top">
                <p className="text-foreground">{row.value}</p>
                {row.detail ? <p className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">{row.detail}</p> : null}
              </td>
              <td className="mt-1 block text-right sm:mt-0 sm:table-cell sm:py-2.5 sm:align-top">
                {row.strategy ? (
                  <SocialStartButton strategy={row.strategy} provider={row.label} />
                ) : (
                  <Link
                    href={row.tryHref}
                    className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Try it
                    <ArrowUpRight className="size-3" aria-hidden="true" />
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function FeatureMatrix({ sections }: { sections: FeatureSection[] }) {
  return (
    <div className="space-y-8">
      <Summary sections={sections} />
      {sections.map((section) => (
        <FeatureTable key={section.id} section={section} />
      ))}
    </div>
  );
}
