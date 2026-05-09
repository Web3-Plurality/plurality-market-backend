const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: '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' });

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "You are a helpful assistant designed to analysis of people tweets and fetch insights from it and output it into JSON.",
      },
      { role: "user", content: "Fetch interests and tags from this tweet and make json of it " + "'#Estonian #mobility unicorn \n @boltappis preparing for an IPO, raising additional €220M of funding. The company, currently operating in over 45 countries, eyes a much bigger expansion.'" },
    ],
    model: "gpt-3.5-turbo-0125",
    response_format: { type: "json_object" },// eslint-disable-line
  });
  console.log(completion.choices[0].message.content);
}

main();