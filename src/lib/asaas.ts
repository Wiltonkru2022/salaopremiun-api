import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./supabase.js";

type AnyRecord = Record<string, unknown>;

const PAID_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]);
const PAID_STATUSES = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
const TERMINAL_EVENTS = new Set([
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
  "PAYMENT_BANK_SLIP_CANCELLED",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
]);
const TERMINAL_STATUSES = new Set([
  "REFUNDED",
  "REFUND_REQUESTED",
  "CHARGEBACK_DISPUTE",
  "CHARGEBACK_REQUESTED",
  "CHARGEBACK_RECEIVED",
  "AWAITING_CHARGEBACK_REVERSAL",
  "DUNNING_REQUESTED",
  "DUNNING_RECEIVED",
  "DUNNING_RETURNED",
  "CANCELLED",
]);

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toMiddayIso(dateOnly?: unknown) {
  const value = String(dateOnly || "").slice(0, 10);
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isPaid(event: string, status: string) {
  return PAID_EVENTS.has(event) || PAID_STATUSES.has(status);
}

function isTerminal(event: string, status: string) {
  return TERMINAL_EVENTS.has(event) || TERMINAL_STATUSES.has(status);
}

function eventOrder(event: string, status: string) {
  if (isTerminal(event, status)) return 120;
  if (isPaid(event, status)) return 100;
  if (event === "PAYMENT_OVERDUE" || status === "OVERDUE") return 60;
  if (event === "PAYMENT_RESTORED" || status === "PENDING") return 40;
  return 20;
}

function mapStatus(event: string, status: string) {
  if (isPaid(event, status)) return "ativo";
  if (isTerminal(event, status)) return "cancelada";
  if (event === "PAYMENT_OVERDUE" || status === "OVERDUE") return "vencida";
  if (event === "PAYMENT_RESTORED" || status === "PENDING") return "pendente";
  return "pendente";
}

function fingerprint(event: string, payment: AnyRecord) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        event,
        paymentId: String(payment.id || ""),
        status: String(payment.status || ""),
        billingType: String(payment.billingType || ""),
        confirmedDate: String(payment.confirmedDate || ""),
        paymentDate: String(payment.paymentDate || ""),
        clientPaymentDate: String(payment.clientPaymentDate || ""),
        dueDate: String(payment.dueDate || ""),
        deleted: Boolean(payment.deleted),
        value: String(payment.value || ""),
      }),
    )
    .digest("hex");
}

async function registrarEvento(body: AnyRecord, event: string, paymentId: string, paymentStatus: string) {
  const supabase = getSupabaseAdmin()!;
  const now = new Date().toISOString();
  const fp = fingerprint(event, asRecord(body.payment));
  const idempotenciaKey = String(body.id || "").trim() || `${paymentId}:${event}`;
  const order = eventOrder(event, paymentStatus);

  const { data: inserted, error } = await supabase
    .from("asaas_webhook_eventos")
    .insert({
      fingerprint: fp,
      idempotencia_key: idempotenciaKey,
      event_type: event,
      evento: event,
      payment_id: paymentId,
      payment_status: paymentStatus || null,
      status_processamento: "processando",
      tentativas: 1,
      payload: body,
      primeiro_recebido_em: now,
      ultimo_recebido_em: now,
      updated_at: now,
      event_order: order,
    })
    .select("id, status_processamento, tentativas")
    .single();

  if (!error && inserted?.id) {
    return { id: inserted.id as string, shouldProcess: true, eventOrder: order };
  }

  if (error?.code !== "23505") throw error;

  const { data: existing, error: existingError } = await supabase
    .from("asaas_webhook_eventos")
    .select("id, status_processamento, tentativas")
    .or(`fingerprint.eq.${fp},idempotencia_key.eq.${idempotenciaKey}`)
    .limit(1)
    .maybeSingle();

  if (existingError || !existing?.id) throw existingError || error;

  const previousStatus = String(existing.status_processamento || "processando");
  await supabase
    .from("asaas_webhook_eventos")
    .update({
      payload: body,
      payment_status: paymentStatus || null,
      tentativas: Number(existing.tentativas || 0) + 1,
      ultimo_recebido_em: now,
      updated_at: now,
      event_order: order,
      status_processamento: previousStatus === "erro" ? "processando" : previousStatus,
      erro_mensagem: previousStatus === "erro" ? null : undefined,
      processado_em: previousStatus === "erro" ? null : undefined,
    })
    .eq("id", existing.id);

  return { id: existing.id as string, shouldProcess: previousStatus === "erro", eventOrder: order };
}

async function updateWebhookStatus(id: string | null, status: "processado" | "erro", message?: string | null, extra?: AnyRecord) {
  if (!id) return;
  await getSupabaseAdmin()!
    .from("asaas_webhook_eventos")
    .update({
      status_processamento: status,
      erro_mensagem: message || null,
      updated_at: new Date().toISOString(),
      ...(status === "processado" ? { processado_em: new Date().toISOString() } : {}),
      ...(extra || {}),
    })
    .eq("id", id);
}

async function loadContext(paymentId: string, payment: AnyRecord) {
  const supabase = getSupabaseAdmin()!;
  const { data: cobranca, error: chargeError } = await supabase
    .from("assinaturas_cobrancas")
    .select("id,id_salao,id_assinatura,id_plano,status,forma_pagamento,referencia,confirmed_date,payment_date,webhook_event_order,asaas_subscription_id")
    .eq("asaas_payment_id", paymentId)
    .maybeSingle();

  if (chargeError) throw chargeError;
  if (!cobranca?.id_assinatura) return { cobranca: null, assinatura: null, plano: null };

  const { data: assinatura, error: assinaturaError } = await supabase
    .from("assinaturas")
    .select("id,id_salao,plano,status,valor,vencimento_em,trial_fim_em,limite_profissionais,limite_usuarios,asaas_subscription_id,asaas_credit_card_token,asaas_credit_card_brand,asaas_credit_card_last4,asaas_credit_card_tokenized_at")
    .eq("id", cobranca.id_assinatura)
    .maybeSingle();

  if (assinaturaError) throw assinaturaError;
  if (!assinatura?.id) return { cobranca, assinatura: null, plano: null };

  const { data: plano, error: planoError } = cobranca.id_plano
    ? await supabase
        .from("planos_saas")
        .select("id,codigo,nome,valor_mensal,limite_usuarios,limite_profissionais,ativo")
        .eq("id", cobranca.id_plano)
        .eq("ativo", true)
        .maybeSingle()
    : { data: null, error: null };

  if (planoError) throw planoError;
  return { cobranca, assinatura, plano, subscriptionId: String(payment.subscription || cobranca.asaas_subscription_id || "").trim() || null };
}

function getCardSnapshot(payment: AnyRecord) {
  const card = asRecord(payment.creditCard);
  return {
    token: String(card.creditCardToken || "").trim() || null,
    brand: String(card.creditCardBrand || "").trim() || null,
    last4: String(card.creditCardNumber || "").trim() || null,
    tokenizedAt: card.creditCardToken ? new Date().toISOString() : null,
  };
}

export async function processAsaasWebhookOfficial(body: AnyRecord) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase da VPS não configurado.");

  const event = String(body.event || "").toUpperCase();
  const payment = asRecord(body.payment);
  const paymentId = String(payment.id || "").trim();
  if (!paymentId) return { ok: true, ignored: true, reason: "no_payment_id" };

  const paymentStatus = String(payment.status || "").toUpperCase();
  const billingType = String(payment.billingType || "").toUpperCase() || null;
  const now = new Date();
  const nowIso = now.toISOString();
  const registro = await registrarEvento(body, event, paymentId, paymentStatus);

  if (!registro.shouldProcess) {
    return { ok: true, ignored: true, reason: "duplicate_event", event };
  }

  try {
    const { cobranca, assinatura, plano, subscriptionId } = await loadContext(paymentId, payment);
    if (!cobranca || !assinatura) {
      await updateWebhookStatus(registro.id, "erro", "charge_or_subscription_not_found");
      return { ok: true, ignored: true, reason: "charge_or_subscription_not_found" };
    }

    const internalStatus = mapStatus(event, paymentStatus);
    const order = registro.eventOrder;
    const previousOrder = Number(cobranca.webhook_event_order || 0);
    if (previousOrder > 0 && order < previousOrder) {
      await updateWebhookStatus(registro.id, "processado", null, {
        id_salao: cobranca.id_salao || assinatura.id_salao,
        id_assinatura: assinatura.id,
        id_cobranca: cobranca.id,
        event_order: order,
        decisao: "ignored_older_event",
      });
      return { ok: true, ignored: true, reason: "older_event", event };
    }

    const confirmedDateIso = toMiddayIso(payment.confirmedDate) || toMiddayIso(payment.paymentDate) || null;
    const paymentDateIso = toMiddayIso(payment.clientPaymentDate) || toMiddayIso(payment.paymentDate) || confirmedDateIso;
    await supabase
      .from("assinaturas_cobrancas")
      .update({
        status: internalStatus,
        forma_pagamento: billingType || cobranca.forma_pagamento || null,
        confirmed_date: isPaid(event, paymentStatus) ? confirmedDateIso || nowIso : confirmedDateIso,
        payment_date: isPaid(event, paymentStatus) ? paymentDateIso || nowIso : paymentDateIso,
        bank_slip_url: payment.bankSlipUrl || null,
        invoice_url: payment.invoiceUrl || null,
        webhook_last_event: event,
        webhook_payload: body,
        webhook_event_order: order,
        webhook_processed_at: nowIso,
        asaas_status: paymentStatus || null,
        asaas_subscription_id: subscriptionId,
        deleted: Boolean(payment.deleted),
      })
      .eq("id", cobranca.id)
      .throwOnError();

    if (isPaid(event, paymentStatus)) {
      const baseDate = assinatura.vencimento_em ? new Date(`${assinatura.vencimento_em}T23:59:59`) : now;
      const nextDue = addDays(Number.isNaN(baseDate.getTime()) || baseDate < now ? now : baseDate, 30);
      const card = getCardSnapshot(payment);
      const planCode = String(plano?.codigo || assinatura.plano || "premium");
      const planValue = plano ? toNumber(plano.valor_mensal) : toNumber(assinatura.valor);
      const limiteUsuarios = plano ? toNumber(plano.limite_usuarios) : toNumber(assinatura.limite_usuarios);
      const limiteProfissionais = plano ? toNumber(plano.limite_profissionais) : toNumber(assinatura.limite_profissionais);

      await supabase
        .from("assinaturas")
        .update({
          status: "ativo",
          plano: planCode,
          valor: planValue,
          pago_em: paymentDateIso || nowIso,
          vencimento_em: nextDue.toISOString().slice(0, 10),
          trial_ativo: false,
          trial_inicio_em: null,
          trial_fim_em: null,
          limite_profissionais: limiteProfissionais,
          limite_usuarios: limiteUsuarios,
          forma_pagamento_atual: billingType || cobranca.forma_pagamento || null,
          gateway: "asaas",
          asaas_payment_id: paymentId,
          referencia_atual: cobranca.referencia || paymentId,
          id_cobranca_atual: cobranca.id,
          asaas_subscription_id: subscriptionId,
          asaas_credit_card_token: card.token || assinatura.asaas_credit_card_token || null,
          asaas_credit_card_brand: card.brand || assinatura.asaas_credit_card_brand || null,
          asaas_credit_card_last4: card.last4 || assinatura.asaas_credit_card_last4 || null,
          asaas_credit_card_tokenized_at: card.tokenizedAt || assinatura.asaas_credit_card_tokenized_at || null,
        })
        .eq("id", assinatura.id)
        .throwOnError();

      await supabase
        .from("saloes")
        .update({
          status: "ativo",
          plano: planCode,
          trial_ativo: false,
          trial_inicio_em: null,
          trial_fim_em: null,
          limite_profissionais: limiteProfissionais,
          limite_usuarios: limiteUsuarios,
          updated_at: nowIso,
        })
        .eq("id", assinatura.id_salao)
        .throwOnError();

      await updateWebhookStatus(registro.id, "processado", null, {
        id_salao: cobranca.id_salao || assinatura.id_salao,
        id_assinatura: assinatura.id,
        id_cobranca: cobranca.id,
        event_order: order,
        decisao: "paid_applied_by_vps",
      });
      return { ok: true, updated: "paid", event };
    }

    if (event === "PAYMENT_OVERDUE" || event === "PAYMENT_RESTORED" || isTerminal(event, paymentStatus)) {
      await supabase
        .from("assinaturas")
        .update({ status: internalStatus, trial_ativo: false, id_cobranca_atual: cobranca.id })
        .eq("id", assinatura.id)
        .throwOnError();

      await supabase
        .from("saloes")
        .update({ status: internalStatus, trial_ativo: false, updated_at: nowIso })
        .eq("id", assinatura.id_salao)
        .throwOnError();
    }

    await updateWebhookStatus(registro.id, "processado", null, {
      id_salao: cobranca.id_salao || assinatura.id_salao,
      id_assinatura: assinatura.id,
      id_cobranca: cobranca.id,
      event_order: order,
      decisao: `status_applied_${internalStatus}`,
    });
    return { ok: true, updated: internalStatus, event };
  } catch (error) {
    await updateWebhookStatus(registro.id, "erro", error instanceof Error ? error.message : "Erro webhook Asaas.");
    throw error;
  }
}
