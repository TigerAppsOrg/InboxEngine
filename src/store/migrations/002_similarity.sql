-- Word-overlap (Jaccard) similarity for duplicate detection, without requiring pg_trgm.
CREATE OR REPLACE FUNCTION similarity_words(a text, b text) RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH x AS (SELECT DISTINCT w FROM regexp_split_to_table(lower(coalesce(a, '')), '[^a-z0-9]+') w WHERE length(w) > 2),
       y AS (SELECT DISTINCT w FROM regexp_split_to_table(lower(coalesce(b, '')), '[^a-z0-9]+') w WHERE length(w) > 2)
  SELECT CASE WHEN (SELECT count(*) FROM (SELECT w FROM x UNION SELECT w FROM y) u) = 0 THEN 0
    ELSE (SELECT count(*) FROM x JOIN y USING (w))::real / (SELECT count(*) FROM (SELECT w FROM x UNION SELECT w FROM y) u) END
$$;
