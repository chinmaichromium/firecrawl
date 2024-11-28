import axios from "axios";
import * as cheerio from "cheerio";
import FirecrawlApp from "@mendable/firecrawl-js";
import { z } from "zod";
// import { Parser } from "json2csv";
// import fs from "fs";
import { createClient } from "@supabase/supabase-js";

// Create a single supabase client for interacting with your database
export const supabase = createClient(
  "https://pbmelmgxyryzcpuinbnp.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBibWVsbWd4eXJ5emNwdWluYm5wIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczMjcwMDI1NCwiZXhwIjoyMDQ4Mjc2MjU0fQ.Tx3tEiur4Otjt78zsgGVLdnLCO8mW6Dr2I9epZg-kyQ"
);

const app = new FirecrawlApp({
  apiUrl: "http://localhost:3002",
  apiKey: "",
});

const visitedLinks = new Set(); // To track visited URLs
const collectedLinks = []; // Array to store all the crawled links
const searchQueries = [
  "faculty",
  "directory",
  "staff",
  "people",
  "page",
  "faculty-staff",
  "admin",
  "our-people",
  "employee-directory",
  "about-us",
]; // Keywords to match links

const criticalKeyWords = ["faculty"];

async function crawl(startUrl, depth = 0) {
  const baseDomain = getBaseDomain(startUrl);

  if (visitedLinks.has(startUrl)) {
    return; // Stop if already visited
  }

  visitedLinks.add(startUrl);
  collectedLinks.push(startUrl); // Add to the array of collected links

  try {
    const response = await axios.get(startUrl);
    const $ = cheerio.load(response.data);

    // Extract raw links
    const rawLinks = $("a")
      .map((_, element) => $(element).attr("href"))
      .get();

    // Filter and normalize links
    const links = rawLinks
      .filter((link) => link && isValidLink(link, baseDomain))
      .map((link) => normalizeLink(link, startUrl, baseDomain))
      .filter((link) => link && performCosineSimilarity(link, searchQueries));

    // Crawl filtered links
    for (const link of links) {
      if (!visitedLinks.has(link)) {
        await crawl(link, depth + 1); // Recursively crawl
      }
    }
  } catch (error) {
    console.error(`Error crawling ${startUrl}:`, error.message);
  }
}

function getBaseDomain(url) {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.protocol}//${parsedUrl.hostname}`;
  } catch (error) {
    console.error(`Invalid start URL: ${url}`);
    throw error;
  }
}

function normalizeLink(link, currentUrl, baseDomain) {
  try {
    // Resolve relative links using current URL
    const urlObj = new URL(link, currentUrl);

    // Check if the link belongs to the same domain
    const baseHostname = new URL(baseDomain).hostname;
    if (urlObj.hostname === baseHostname) {
      return urlObj.href; // Return full URL
    }

    return null; // Exclude links outside the base domain
  } catch (error) {
    console.error(
      `Error normalizing link '${link}' with base '${currentUrl}':`,
      error.message
    );
    return null; // Return null for invalid URLs
  }
}

function isValidLink(link, baseDomain) {
  try {
    const urlObj = new URL(link, baseDomain); // Resolve relative links
    const isSameDomain = urlObj.hostname === new URL(baseDomain).hostname; // Check domain
    const isMailto = urlObj.protocol === "mailto:"; // Exclude mailto links
    const isAnchor = urlObj.href.includes("#"); // Exclude anchor links

    return isSameDomain && !isMailto && !isAnchor;
  } catch (error) {
    console.error(`Error validating link ${link}:`, error.message);
    return false; // Default to invalid on error
  }
}

function performCosineSimilarity(link, searchQueries, threshold = 0.4) {
  const cosineSimilarity = (vec1, vec2) => {
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
    const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
    const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));
    if (magnitude1 === 0 || magnitude2 === 0) return 0;
    return dotProduct / (magnitude1 * magnitude2);
  };

  const textToVector = (text, vocabulary) => {
    const wordCounts = text
      .toLowerCase()
      .split(/\W+/)
      .reduce((counts, word) => {
        counts[word] = (counts[word] || 0) + 1;
        return counts;
      }, {});

    // Boost specific terms
    vocabulary.forEach((term) => {
      if (wordCounts[term]) {
        wordCounts[term] *= 2; // Double the weight of matching terms
      }
    });

    return vocabulary.map((word) => wordCounts[word] || 0);
  };

  try {
    // Extract the path from the URL for comparison
    const url = new URL(link);
    const path = url.pathname.toLowerCase(); // E.g., "/directory"

    // Create vocabulary from the path and search queries
    const vocabulary = Array.from(
      new Set(
        path
          .split(/\W+/)
          .concat(
            searchQueries.flatMap((query) => query.toLowerCase().split(/\W+/))
          )
      )
    );

    // Generate vectors for the path
    const pathVector = textToVector(path, vocabulary);

    // Check similarity with each search query and log scores
    const scores = searchQueries.map((query) => {
      const queryVector = textToVector(query, vocabulary);
      const score = cosineSimilarity(pathVector, queryVector);

      return score;
    });

    // Return true if any score exceeds the threshold
    return scores.some((score) => score >= threshold);
  } catch (error) {
    console.error(
      `Error in similarity calculation for ${link}:`,
      error.message
    );
    return false; // Default to false if error occurs
  }
}

const schema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().describe("Full name"),
        phone: z.string(),
        email: z.string(),
        jobTitle: z.string(),
      })
    )
    .describe(
      "List of staffs or faculty memmbers. Extract only personal contacts"
    ),
});

async function processInBatches(array, batchSize, callback, processResult) {
  const batches = [];

  // Split the array into batches
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }

  // Process each batch
  await Promise.all(
    batches.map(async (batch) => {
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          try {
            return await callback(item); // Process each item
          } catch (error) {
            console.error(`Error processing item ${item}:`, error);
            return null; // Return null for failed items
          }
        })
      );

      // Save results for successful items
      await Promise.all(
        batchResults
          .filter((result) => result !== null) // Exclude failed items
          .map(async (result) => {
            try {
              await processResult(result); // Save result
            } catch (error) {
              console.error("Error saving result to the database:", error);
            }
          })
      );
    })
  );
}

async function saveContactsToDatabase(result, schoolId) {
  if (!result.success) return;

  const contacts = result.extract.contacts.filter(
    (contact) => contact.email || contact.phone
  );

  // Deduplicate contacts before saving
  const uniqueContacts = deduplicateContactsByEmail(contacts);

  if (uniqueContacts.length > 0) {
    try {
      await supabase
        .from("school_contacts")
        .insert(
          uniqueContacts.map((res) => ({
            name: res.name,
            phone: res.phone,
            email: res.email,
            job_title: res.jobTitle,
            school_id: schoolId,
          }))
        )
        .throwOnError();
      console.log(`Saved ${uniqueContacts.length} contacts to database.`);
    } catch (error) {
      console.error("Error inserting contacts into the database:", error);
    }
  }
}

function deduplicateContactsByEmail(contacts) {
  const uniqueContacts = [];
  const seenEmails = new Set();

  for (const contact of contacts) {
    if (contact.email && !seenEmails.has(contact.email)) {
      seenEmails.add(contact.email);
      uniqueContacts.push(contact);
    } else if (!contact.email) {
      // Include contacts without email if they have a phone
      uniqueContacts.push(contact);
    }
  }

  return uniqueContacts;
}

(async () => {
  // Fetch schools from the database
  const dbSchools = (
    await supabase
      .from("schools")
      .select("*,school_contacts(*)")
      .eq("is_contact_crawled", false)
      .order("name", { ascending: true })
      .throwOnError()
  ).data;

  // Filter schools with no existing contacts
  const unCrawledSchools = dbSchools.filter(
    (school) => school.school_contacts.length === 0
  );

  // Select the first uncrawled school
  const selectedSchool = unCrawledSchools[0];
  if (!selectedSchool) {
    console.log("No school selected");
    return;
  }
  console.log("Selected School:", selectedSchool);

  // Mark the selected school as crawled in the database
  await supabase
    .from("schools")
    .update({ is_contact_crawled: true })
    .eq("id", selectedSchool.id)
    .throwOnError();

  // Start crawling from the school's website
  const startUrl = selectedSchool.website;
  await crawl(startUrl);
  console.log("Collected Links:", collectedLinks);

  try {
    // Process collected links in batches of 10 and save contacts immediately
    await processInBatches(
      collectedLinks,
      10,
      (link) =>
        app.scrapeUrl(link, {
          formats: ["extract"],
          extract: { schema: schema },
          timeout: 120000, // Set a timeout of 2 minutes
        }),
      (result) => saveContactsToDatabase(result, selectedSchool.id)
    );

    console.log("Processing and saving completed.");
  } catch (error) {
    console.error("An error occurred during batch processing:", error);
  }
})();
