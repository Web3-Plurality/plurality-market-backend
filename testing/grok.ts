"use strict";
const Groq = require("groq-sdk");
const groq = new Groq({
    apiKey: process.env.GROQ_API
});


async function analyzeTweet(tweet) {
    const chatCompletion = await getGroqChatCompletion(tweet);

    const text = chatCompletion.choices[0]?.message?.content


    const jsonMatch = text.match(/```(.*?)```/s);
    if (jsonMatch && jsonMatch[1]) {
      try {
        // Parse the JSON
        const jsonData = JSON.parse(jsonMatch[1]);
        // console.log('Extracted JSON:', jsonData);
        return jsonData
      } catch (error) {
        console.error('Error parsing JSON:', error.message);
      }
    } else {
      console.log('No JSON block found.');
    }

}
async function getGroqChatCompletion(tweet) {
    return groq.chat.completions.create({
        messages: [
            {
                role: "user",
                content: `Fetch interests and tags from this tweet and make json of it. The json schema should contain the following Objects: Interests (also include other related topic to this text), hashtags (also extra tags that are related )
                Text:
                "${tweet}"
                `
            } 
        ],
        model: "llama3-70b-8192"
    });
}





module.exports =  {analyzeTweet}

