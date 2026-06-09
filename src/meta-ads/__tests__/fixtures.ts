/**
 * A representative slice of a real `AdLibrarySearchPaginationQuery` response (captured live from
 * the Ad Library for `q=vitalityextracts.com`, then reduced to synthetic media URLs). It exercises
 * every shape the parser must handle: an IMAGE ad, a VIDEO ad, a DCO ad whose top-level fields are
 * `{{…}}` templates with the real creative in `cards[]`, and an ad from a connected affiliate page.
 */
export const searchResponse = {
  data: {
    ad_library_main: {
      search_results_connection: {
        edges: [
          {
            node: {
              collated_results: [
                {
                  ad_archive_id: "111",
                  collation_count: 5,
                  is_active: true,
                  page_id: "821291691309623",
                  page_name: "Vitality Extracts Essential Oils",
                  start_date: 1700000000,
                  end_date: 1780988400,
                  publisher_platform: ["FACEBOOK", "INSTAGRAM"],
                  currency: "",
                  spend: null,
                  impressions_with_index: { impressions_text: null, impressions_index: -1 },
                  snapshot: {
                    display_format: "IMAGE",
                    caption: "vitalityextracts.com",
                    body: { text: "Tired of stiff joints? Our Frankincense Balm melts away daily aches." },
                    title: "Frankincense Balm",
                    link_url: "https://www.vitalityextracts.com/products/frankincense-balm",
                    link_description: "Fast, non-greasy relief.",
                    cta_text: "Shop now",
                    cta_type: "SHOP_NOW",
                    page_profile_uri: "https://www.facebook.com/vitalityextracts/",
                    page_like_count: 1296770,
                    page_categories: ["Health/beauty"],
                    images: [
                      {
                        original_image_url: "https://example.test/img1.jpg",
                        resized_image_url: "https://example.test/img1-s.jpg",
                      },
                    ],
                    videos: [],
                    cards: [],
                  },
                },
                {
                  ad_archive_id: "222",
                  collation_count: 2,
                  is_active: true,
                  page_id: "821291691309623",
                  page_name: "Vitality Extracts Essential Oils",
                  start_date: 1700000000,
                  publisher_platform: ["FACEBOOK"],
                  snapshot: {
                    display_format: "VIDEO",
                    caption: "vitalityextracts.com",
                    body: { text: "From a 6 to a 1 in minutes. Watch how our balm works." },
                    title: "Real relief",
                    link_url: "https://www.vitalityextracts.com/products/helichrysum",
                    cta_text: "Learn more",
                    cta_type: "LEARN_MORE",
                    images: [],
                    videos: [
                      {
                        video_hd_url: "https://example.test/v-hd.mp4",
                        video_sd_url: "https://example.test/v-sd.mp4",
                        video_preview_image_url: "https://example.test/v-poster.jpg",
                      },
                    ],
                    cards: [],
                  },
                },
              ],
            },
          },
          {
            node: {
              collated_results: [
                {
                  ad_archive_id: "333",
                  collation_count: 1,
                  is_active: true,
                  page_id: "821291691309623",
                  page_name: "Vitality Extracts Essential Oils",
                  start_date: 1700000000,
                  publisher_platform: ["FACEBOOK", "INSTAGRAM", "MESSENGER"],
                  snapshot: {
                    display_format: "DCO",
                    caption: "vitalityextracts.com",
                    body: { text: "{{product.description}}" },
                    title: "{{product.name}}",
                    link_description: "{{product.description}}",
                    cta_text: "Learn More",
                    cta_type: "LEARN_MORE",
                    images: [],
                    videos: [],
                    cards: [
                      {
                        body: "From a 6 to a 1 in Minutes. One customer described her knee pain after applying our balm.",
                        title: "From a 6 to a 1 in Minutes",
                        link_url: "https://www.vitalityextracts.com/products/frankincense-balm",
                        cta_text: "Learn More",
                        cta_type: "LEARN_MORE",
                        original_image_url: null,
                        resized_image_url: null,
                        video_hd_url: "https://example.test/card-hd.mp4",
                        video_sd_url: "https://example.test/card-sd.mp4",
                        video_preview_image_url: "https://example.test/card-poster.jpg",
                      },
                      {
                        body: "Second card copy.",
                        title: "Second",
                        original_image_url: "https://example.test/card2.jpg",
                      },
                    ],
                  },
                },
                {
                  ad_archive_id: "444",
                  collation_count: 3,
                  is_active: false,
                  page_id: "999000111",
                  page_name: "Families For Wellness",
                  start_date: 1700000000,
                  publisher_platform: ["FACEBOOK"],
                  snapshot: {
                    display_format: "IMAGE",
                    caption: "vitalityextracts.com",
                    body: { text: "I deal with chronic pain and these oils changed everything. - Kathy J." },
                    title: "Real customer story",
                    link_url: "https://www.vitalityextracts.com/",
                    cta_text: "Shop now",
                    cta_type: "SHOP_NOW",
                    page_like_count: 5000,
                    images: [{ original_image_url: "https://example.test/aff.jpg" }],
                    videos: [],
                    cards: [],
                  },
                },
              ],
            },
          },
        ],
        page_info: { end_cursor: "CURSORABC", has_next_page: true },
      },
    },
  },
  extensions: {},
}
