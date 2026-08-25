export const DEFAULT_PARSER_LIMITS = Object.freeze({
  deadline_seconds: 120,
  max_archive_entries: 1024,
  max_cells: 100000,
  max_compression_ratio: 1000,
  max_expanded_bytes: 100 * 1024 * 1024,
  max_images: 20,
  max_input_bytes: 25 * 1024 * 1024,
  max_media_seconds: 15 * 60,
  max_pdf_pages: 500,
  max_recursion_depth: 3,
  max_slides: 500,
  max_text_chars: 240000
});
