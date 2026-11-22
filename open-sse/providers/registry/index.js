// Lean provider registry — Google Vertex AI & Google AI Studio (Gemini) only
import gemini from "./gemini.js";
import vertex from "./vertex.js";
import vertexPartner from "./vertex-partner.js";

export default [vertex, gemini, vertexPartner];
