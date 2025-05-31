export const definitions = {
  fullName: {
    type: "string",
    // Exactly two letter‐only strings separated by one space, no leading/trailing spaces:
    pattern: "^[A-Za-z]+ [A-Za-z]+$",
    description: "Exactly two words (letters only), separated by a single space"
  },
  phoneNumber: {
    type: "string",
    pattern: "^07[0-9]{8}$",
    description: "Enter a valid phone number following the format 0712345678"
  },
  babyName: {
    type: "string",
    // Exactly two letter‐only strings separated by one space, no leading/trailing spaces:
    pattern: "^[A-Za-z]+ [A-Za-z]+$",
    description: "Exactly two words (letters only), separated by a single space"
  },
  dateOfBirth: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description: "ISO date YYYY-MM-DD"
  },
  gender: {
    type: "string",
    enum: ["Male", "Female"],
    description: "Allowed gender values"
  }
};

export const profileUpdateSchema = {
  type: "object",
  required: ["fullName", "phoneNumber", "babyName", "dateOfBirth", "gender"],
  properties: {
    fullName: { $ref: "#/definitions/fullName" },
    phoneNumber: { $ref: "#/definitions/phoneNumber" },
    babyName: { $ref: "#/definitions/babyName" },
    dateOfBirth: { $ref: "#/definitions/dateOfBirth" },
    gender: { $ref: "#/definitions/gender" }
  },
  additionalProperties: false,
  definitions
};

export const addBabySchema = {
  type: "object",
  required: ["babyName", "dateOfBirth", "gender"],
  properties: {
    babyName: { $ref: "#/definitions/babyName" },
    dateOfBirth: { $ref: "#/definitions/dateOfBirth" },
    gender: { $ref: "#/definitions/gender" }
  },
  additionalProperties: false,
  definitions
};
