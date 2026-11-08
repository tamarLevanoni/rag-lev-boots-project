import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv"; // to read the .env file

dotenv.config();
const gemini = new GoogleGenAI({}); // initialize the Gemini client and automatically loads the API key from the .env file

export const askGemini = async (model: string, userPrompt: string, systemPrompt: string) => {
  try {
    const result = await gemini.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
      },
    });

    return result;
  } catch (error) {
    console.error("Error generating content with LLM:", error);
    throw error;
  }
};
