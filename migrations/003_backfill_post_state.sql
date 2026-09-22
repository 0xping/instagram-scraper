UPDATE posts SET
  type = CASE kind
    WHEN 'reel' THEN 'reel'
    WHEN 'carousel' THEN 'carousel'
    WHEN 'post' THEN 'image'
    ELSE 'unknown'
  END,
  discovery_status = 'complete',
  extraction_status = status,
  first_scraped_at = collected_at,
  last_scraped_at = collected_at;
