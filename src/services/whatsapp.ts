import axios from 'axios';
import { logger } from '../lib/logger';
import { env } from '../config/env';

const INTERAKT_BASE = 'https://api.interakt.ai/v1/public';

interface WhatsAppMessage {
  phoneNumber: string;       // Indian format: 919876543210 (91 + 10 digits)
  templateName: string;
  templateParams: string[];  // ordered values matching template placeholders
  mediaUrl?: string;         // for invoice PDF link
}

/**
 * Sends a WhatsApp message via Interakt API.
 * Never throws an error to prevent blocking critical paths (like sales).
 */
export async function sendWhatsAppMessage(msg: WhatsAppMessage): Promise<boolean> {
  // If no API key is configured, just log and skip to allow dev environment to work without crashing.
  if (!env.WHATSAPP_API_KEY) {
    logger.warn('WhatsApp API Key not configured. Skipping message delivery:', { phone: msg.phoneNumber, template: msg.templateName });
    return false;
  }

  try {
    const payload: any = {
      countryCode: '+91',
      phoneNumber: msg.phoneNumber.replace(/^91/, '').replace(/^\+91/, ''),
      callbackData: 'medpos_notification',
      type: 'Template',
      template: {
        name: msg.templateName,
        languageCode: 'en',
        bodyValues: msg.templateParams,
      },
    };

    if (msg.mediaUrl) {
      payload.template.headerValues = [msg.mediaUrl];
    }

    await axios.post(`${INTERAKT_BASE}/message/`, payload, {
      headers: {
        Authorization: `Basic ${env.WHATSAPP_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    logger.info('WhatsApp sent', { phone: msg.phoneNumber, template: msg.templateName });
    return true;
  } catch (err: any) {
    logger.error('WhatsApp failed', {
      phone: msg.phoneNumber,
      template: msg.templateName,
      error: err.response?.data || err.message,
    });
    return false;
  }
}

// ─── Template Wrappers ───────────────────────────────────────────────

/**
 * Template: invoice_ready
 * Body: "Hi {1}, your invoice {2} for ₹{3} from {4} is ready. View here: {5}"
 */
export async function sendInvoiceWhatsApp(params: {
  customerPhone: string;
  customerName: string;
  invoiceNumber: string;
  netAmount: number;
  clinicName: string;
  invoiceUrl: string;
}): Promise<boolean> {
  return sendWhatsAppMessage({
    phoneNumber: params.customerPhone,
    templateName: 'invoice_ready',
    templateParams: [
      params.customerName,
      params.invoiceNumber,
      params.netAmount.toFixed(2),
      params.clinicName,
      params.invoiceUrl,
    ],
  });
}

/**
 * Template: refill_reminder
 * Body: "Hi {1}, it's time to refill {2}. Visit {3} or call {4}."
 */
export async function sendRefillReminderWhatsApp(params: {
  customerPhone: string;
  customerName: string;
  medicineList: string;   // "Metformin 500mg, Amlodipine 5mg"
  clinicName: string;
  clinicPhone: string;
}): Promise<boolean> {
  return sendWhatsAppMessage({
    phoneNumber: params.customerPhone,
    templateName: 'refill_reminder',
    templateParams: [
      params.customerName,
      params.medicineList,
      params.clinicName,
      params.clinicPhone,
    ],
  });
}

/**
 * Template: outstanding_reminder
 * Body: "Hi {1}, you have an outstanding balance of ₹{2} at {3}. Please clear at your convenience."
 */
export async function sendOutstandingReminderWhatsApp(params: {
  customerPhone: string;
  customerName: string;
  outstandingAmount: number;
  clinicName: string;
}): Promise<boolean> {
  return sendWhatsAppMessage({
    phoneNumber: params.customerPhone,
    templateName: 'outstanding_reminder',
    templateParams: [
      params.customerName,
      params.outstandingAmount.toFixed(2),
      params.clinicName,
    ],
  });
}

/**
 * Template: low_stock_alert (to OWNER)
 * Body: "⚠️ Low stock alert for {1}: {2} medicines are below minimum stock level."
 */
export async function sendLowStockAlertWhatsApp(params: {
  ownerPhone: string;
  clinicName: string;
  count: number;
}): Promise<boolean> {
  return sendWhatsAppMessage({
    phoneNumber: params.ownerPhone,
    templateName: 'low_stock_alert',
    templateParams: [params.clinicName, params.count.toString()],
  });
}
