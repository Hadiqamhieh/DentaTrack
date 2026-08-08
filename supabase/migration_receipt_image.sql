-- Run this in the Supabase SQL Editor.
-- The `receipt` column started out as a plain true/false flag. It needs to
-- hold real data now (the image itself, plus vendor/date/amount) so
-- receipts can actually be viewed later, not just checked off.
--
-- Safe to run whether the column is currently boolean or already jsonb —
-- existing true/false values convert cleanly to jsonb true/false and still
-- work with the "no image saved for this one" fallback in the UI.

do $$
begin
  if (select data_type from information_schema.columns
      where table_name = 'bank_transactions' and column_name = 'receipt') <> 'jsonb' then
    alter table bank_transactions alter column receipt type jsonb using to_jsonb(receipt);
  end if;
end $$;
