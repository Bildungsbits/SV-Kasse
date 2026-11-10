export interface Settings {
  school_name: string;
  sv_name: string;
  low_stock: number;
  code_length: number;
  donation_quick: number[];
}

export interface Article {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
  emoji: string;
  color: string;
  active?: number;
  sort?: number;
}

export interface SaleItem {
  article_id: string;
  name: string;
  unit_price_cents: number;
  qty: number;
}

export interface Sale {
  id: string;
  total_cents: number;
  donation_cents: number;
  paid_cents: number;
  change_cents: number;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  items: SaleItem[];
}

export interface Shift {
  id: string;
  name: string;
  code?: string;
  starting_cents: number;
  status: "ready" | "open" | "closed";
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  counted_cents: number | null;
  note: string;
}

export interface Totals {
  sales_count: number;
  voided_count: number;
  revenue: number;
  donations: number;
  expected: number;
  difference: number | null;
}

export interface CashierState {
  shift: Shift;
  totals: Totals;
  articles: Article[];
  sales: Sale[];
  settings: Settings;
}

export interface Report {
  shift: Shift;
  totals: Totals;
  items: { article_id: string; name: string; unit_price_cents: number; qty: number; revenue: number }[];
  sales: Sale[];
  settings: Settings;
}

export interface ShiftRow extends Shift {
  revenue: number;
  donations: number;
  sales_count: number;
  expected: number;
  difference: number | null;
}

export interface Stats {
  totals: { sales_count: number; revenue: number; donations: number };
  byDay: { day: string; sales_count: number; revenue: number; donations: number }[];
  byArticle: { name: string; qty: number; revenue: number }[];
  shifts: { id: string; name: string; created_at: string; status: string; starting_cents: number; counted_cents: number | null; revenue: number; donations: number }[];
  settings: Settings;
}

export interface StockMovement {
  id: number;
  article_id: string;
  article_name: string | null;
  delta: number;
  reason: string;
  note: string;
  created_at: string;
}
