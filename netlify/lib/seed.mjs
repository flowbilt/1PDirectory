// Starting data. Once a site is saved from the admin page, the saved copy
// (in Netlify Blobs) wins and this seed is ignored for that site.

export const SEED = {
  "landmark-center": {
    propertyName: "The Landmark Center",
    buildingLabel: "",
    logo: "",
    tenants: [
      { name: "EMW Law LLC.", suite: "300", dir: "" },
      { name: "Life Key", suite: "251", dir: "" },
      { name: "Martin Law Firm, LLC.", suite: "220", dir: "" },
      { name: "PRP Logistics", suite: "410", dir: "" },
      { name: "Red Mountain Law Group", suite: "500", dir: "" },
      { name: "Roy M. West d/b/a Manly & Manly, Attorney", suite: "210", dir: "" },
      { name: "The Alabama Messenger", suite: "240", dir: "" },
      { name: "Vogtle Howell Companies", suite: "571", dir: "" },
    ],
    managedBy: { name: "Leigh Ann Kornegay", company: "Barber Companies", phone: "205-995-9116" },
    leasedBy: { name: "Weyman Prater", company: "Barber Companies", phone: "205-995-9119" },
    welcome: "Welcome to The Landmark Center. Have a great day.",
    // Downtown Birmingham. Replace with the building's exact coordinates in admin.
    weather: { enabled: true, lat: 33.5186, lon: -86.8104 },
    timezone: "America/Chicago",
    news: { enabled: true, rotateSeconds: 12 },
    updatedAt: null,
  },
};

export function blankSite(propertyName = "New building") {
  return {
    propertyName,
    buildingLabel: "",
    logo: "",
    tenants: [],
    managedBy: { name: "", company: "", phone: "" },
    leasedBy: { name: "", company: "", phone: "" },
    welcome: "",
    weather: { enabled: true, lat: 33.5186, lon: -86.8104 },
    timezone: "America/Chicago",
    news: { enabled: true, rotateSeconds: 12 },
    updatedAt: null,
  };
}
