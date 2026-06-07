import { SupabaseClient } from '@supabase/supabase-js';

export async function recalculateImportanceScore(
  customerId: string,
  clinicId: string,
  supabase: SupabaseClient
): Promise<void> {
  try {
    // 1. Fetch total sales count + sum + 30days count
    const { data: sales, error } = await supabase
      .from('sales')
      .select('net_amount, sale_date')
      .eq('clinic_id', clinicId)
      .eq('customer_id', customerId);

    if (error || !sales) return;

    let totalCount = sales.length;
    let totalPurchases = sales.reduce((acc, s) => acc + Number(s.net_amount), 0);
    
    // Count last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    let count30d = 0;

    let lastPurchaseDate = null;
    let latestTs = 0;

    sales.forEach(s => {
      const sd = new Date(s.sale_date);
      if (sd > thirtyDaysAgo) count30d++;
      if (sd.getTime() > latestTs) {
        latestTs = sd.getTime();
        lastPurchaseDate = s.sale_date;
      }
    });

    // Score logic:
    // Total sales mapping (0-40 pts): 1 sale = 2 pts
    const scoreTotal = Math.min(totalCount * 2, 40);
    
    // Last 30 days mapping (0-40 pts): 1 sale = 8 pts
    const score30d = Math.min(count30d * 8, 40);

    // Avg net amount per sale mapping (0-20 pts)
    const avgSale = totalCount > 0 ? (totalPurchases / totalCount) : 0;
    // Assume maxing out at average sale of 1000 currency
    const scoreAvg = Math.min((avgSale / 1000) * 20, 20);

    const importanceScore = Math.floor(scoreTotal + score30d + scoreAvg);

    // Update customer
    await supabase.from('customers').update({
      importance_score: importanceScore,
      last_purchase_date: lastPurchaseDate,
      total_purchases: totalPurchases
    }).eq('id', customerId).eq('clinic_id', clinicId);

  } catch (err) {
    console.error('recalculateImportanceScore error:', err);
  }
}
