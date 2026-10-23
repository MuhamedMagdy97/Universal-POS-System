import { Suspense } from "react";
import { translator, type Locale } from "@/lib/i18n";
import { loadPosContext } from "./_lib/context";
import { RegisterPicker } from "./_components/register-picker";
import { OpenShiftForm } from "./_components/open-shift-form";
import { Till } from "./_components/till";
import { CloseShift } from "./_components/close-shift";
import { CashMovement } from "./_components/cash-movement";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function PosPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p aria-busy="true">…</p>}>
      <PosContent searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v.trim() === "" ? undefined : v;
}

function Denied({ locale }: { locale: Locale }) {
  const tr = translator(locale);
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
      <h1 className="text-xl font-semibold">{tr("pos.state.forbidden")}</h1>
      <p className="text-muted">{tr("pos.state.forbiddenBody")}</p>
    </section>
  );
}

async function PosContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const page = await loadPosContext(one(params.branch), one(params.register));
  if (page.kind === "denied") return <Denied locale={page.locale} />;
  const tr = translator(page.locale);
  if (page.kind === "notFound") {
    return (
      <section role="alert" className="flex flex-col gap-2 rounded-md border border-border p-6">
        <h1 className="text-xl font-semibold">{tr("pos.state.notFound")}</h1>
        <RegisterPicker locale={page.locale} branches={page.branches} branchId="" registers={[]} registerId={null} />
      </section>
    );
  }

  const {
    ctx,
    locale,
    branches,
    branch,
    registers,
    register,
    shift,
    shiftCash,
    settings,
    canOpenShift,
    canCloseShift,
    offline,
  } = page;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {tr("pos.title")}
          <span className="ms-2 text-base font-normal text-muted">
            {branch.name}
            {register ? ` · ${register.name}` : ""}
          </span>
        </h1>
        <RegisterPicker
          locale={locale}
          branches={branches}
          branchId={branch.id}
          registers={registers}
          registerId={register?.id ?? null}
        />
      </div>

      {!register ? (
        <p className="text-muted">{tr("pos.noRegisters")}</p>
      ) : !shift ? (
        <section className="flex flex-col gap-3 rounded-md border border-border p-6">
          <h2 className="text-xl font-semibold">{tr("pos.shift.closedTitle")}</h2>
          {canOpenShift ? (
            <>
              <p className="text-muted">{tr("pos.shift.closedBody")}</p>
              <OpenShiftForm
                key={register.id}
                locale={locale}
                branchId={branch.id}
                registerId={register.id}
                currency={settings.currency}
              />
            </>
          ) : (
            <p className="text-muted">{tr("pos.shift.cannotOpen")}</p>
          )}
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {tr("pos.shift.openSince", { time: new Date(shift.openedAt).toLocaleString(locale) })}
            </p>
            <div className="flex flex-wrap items-start gap-3">
              <CashMovement
                key={`cash-${shift.id}`}
                locale={locale}
                shiftId={shift.id}
                currency={settings.currency}
                canCloseShift={canCloseShift}
              />
              {canCloseShift && shiftCash ? (
                <CloseShift
                  key={shift.id}
                  locale={locale}
                  shiftId={shift.id}
                  currency={settings.currency}
                  cash={shiftCash}
                />
              ) : null}
            </div>
          </div>
          <Till
            key={register.id}
            locale={locale}
            branchId={branch.id}
            registerId={register.id}
            userId={ctx.userId}
            settings={settings}
            offline={offline}
          />
        </>
      )}
    </div>
  );
}
