import FirecrawlApp from "@mendable/firecrawl-js";
import { z } from "zod";

const app = new FirecrawlApp({
  apiUrl: "http://localhost:3002",
  apiKey: "",
});

// Define schema to extract contents into
const schema = z.object({
  schools: z
    .array(
      z.object({
        name: z.string(),
        website: z.string(),
        phone: z.string(),
      })
    )
    .describe("List of nursing schools"),
});

(async () => {
  const pages = 41;

  // Generate an array of promises for all pages
  const scrapePromises = Array.from({ length: pages }, (_, index) => {
    const page = index + 1;
    return app.scrapeUrl(`https://allnurses.com/schools/?page=${page}`, {
      formats: ["extract"],
      extract: { schema: schema },
    });
  });

  try {
    // Wait for all requests to complete
    const results = await Promise.all(scrapePromises);

    // Filter successful results and extract schools
    const allSchools = results
      .filter((result) => result.success)
      .flatMap((result) => result.extract.schools);

    console.log(JSON.stringify(allSchools));
  } catch (error) {
    console.error("An error occurred while scraping:", error);
  }
})();
