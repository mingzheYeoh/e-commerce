/**
 * Where this store ships, and what an address looks like there.
 *
 * One table, shared by the checkout form and the order endpoint, because the
 * two have to agree about what a valid address is. When they disagreed the
 * form happily collected a Malaysian postcode and the server refused it as a
 * bad ZIP, which reads to the shopper as a broken checkout.
 *
 * Every country here carries its own vocabulary. "State / ZIP" on a British
 * address is the tell of a form that was built for one country and then had
 * others bolted on, so the labels travel with the country rather than being
 * hardcoded into the markup.
 */

export interface Subdivision {
  code: string
  name: string
}

export interface Country {
  code: string
  name: string
  /** What the subdivision is called here. Absent when the country has none. */
  subdivisionLabel?: string
  subdivisions?: Subdivision[]
  postalLabel: string
  /** Shown in the field, so the expected shape is visible before it is refused. */
  postalExample: string
  postalPattern: RegExp
}

/* ------------------------------------------------------------ subdivisions */

const US_STATES: Subdivision[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
]

const CA_PROVINCES: Subdivision[] = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
]

const AU_STATES: Subdivision[] = [
  { code: 'ACT', name: 'Australian Capital Territory' },
  { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' },
  { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' },
  { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' },
  { code: 'WA', name: 'Western Australia' },
]

const MY_STATES: Subdivision[] = [
  { code: 'JHR', name: 'Johor' },
  { code: 'KDH', name: 'Kedah' },
  { code: 'KTN', name: 'Kelantan' },
  { code: 'KUL', name: 'Kuala Lumpur' },
  { code: 'LBN', name: 'Labuan' },
  { code: 'MLK', name: 'Melaka' },
  { code: 'NSN', name: 'Negeri Sembilan' },
  { code: 'PHG', name: 'Pahang' },
  { code: 'PJY', name: 'Putrajaya' },
  { code: 'PLS', name: 'Perlis' },
  { code: 'PNG', name: 'Pulau Pinang' },
  { code: 'PRK', name: 'Perak' },
  { code: 'SBH', name: 'Sabah' },
  { code: 'SGR', name: 'Selangor' },
  { code: 'SWK', name: 'Sarawak' },
  { code: 'TRG', name: 'Terengganu' },
]

/* ---------------------------------------------------------------- countries */

/**
 * Ordered by how the list reads rather than alphabetically: the markets the
 * currency switcher already offers come first.
 */
export const COUNTRIES: Country[] = [
  {
    code: 'US',
    name: 'United States',
    subdivisionLabel: 'State',
    subdivisions: US_STATES,
    postalLabel: 'ZIP code',
    postalExample: '94016',
    postalPattern: /^\d{5}(-\d{4})?$/,
  },
  {
    code: 'CA',
    name: 'Canada',
    subdivisionLabel: 'Province',
    subdivisions: CA_PROVINCES,
    postalLabel: 'Postal code',
    postalExample: 'M5V 2T6',
    postalPattern: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    postalLabel: 'Postcode',
    postalExample: 'SW1A 1AA',
    postalPattern: /^[A-Za-z]{1,2}\d[A-Za-z\d]? ?\d[A-Za-z]{2}$/,
  },
  {
    code: 'DE',
    name: 'Germany',
    postalLabel: 'Postleitzahl',
    postalExample: '10115',
    postalPattern: /^\d{5}$/,
  },
  {
    code: 'FR',
    name: 'France',
    postalLabel: 'Code postal',
    postalExample: '75001',
    postalPattern: /^\d{5}$/,
  },
  {
    code: 'NL',
    name: 'Netherlands',
    postalLabel: 'Postcode',
    postalExample: '1012 AB',
    postalPattern: /^\d{4} ?[A-Za-z]{2}$/,
  },
  {
    code: 'AU',
    name: 'Australia',
    subdivisionLabel: 'State / Territory',
    subdivisions: AU_STATES,
    postalLabel: 'Postcode',
    postalExample: '2000',
    postalPattern: /^\d{4}$/,
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    postalLabel: 'Postcode',
    postalExample: '1010',
    postalPattern: /^\d{4}$/,
  },
  {
    code: 'SG',
    name: 'Singapore',
    postalLabel: 'Postal code',
    postalExample: '238839',
    postalPattern: /^\d{6}$/,
  },
  {
    code: 'MY',
    name: 'Malaysia',
    subdivisionLabel: 'State',
    subdivisions: MY_STATES,
    postalLabel: 'Postcode',
    postalExample: '50450',
    postalPattern: /^\d{5}$/,
  },
]

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]))

export const findCountry = (code: string): Country | undefined =>
  BY_CODE.get(code.trim().toUpperCase())

/**
 * Whether this subdivision belongs to this country.
 *
 * A country with no subdivisions requires the field to be empty rather than
 * ignoring it: accepting "CA" alongside Singapore would store an address that
 * contradicts itself, and the tax line reads off that same field.
 */
export function validSubdivision(countryCode: string, code: string): boolean {
  const country = findCountry(countryCode)
  if (!country) return false
  if (!country.subdivisions) return code.trim() === ''
  return country.subdivisions.some((s) => s.code === code.trim().toUpperCase())
}

export function validPostal(countryCode: string, postal: string): boolean {
  const country = findCountry(countryCode)
  if (!country) return false
  return country.postalPattern.test(postal.trim())
}

/**
 * A loose phone check, on purpose.
 *
 * Ten countries' numbering plans is a library, not a regex, and a checkout that
 * rejects a correctly written number is worse than one that accepts an odd one:
 * the number exists so a courier can call, and nothing downstream parses it.
 */
export function validPhone(phone: string): boolean {
  const trimmed = phone.trim()
  if (!trimmed) return true
  const digits = trimmed.replace(/[^\d]/g, '')
  return /^\+?[\d\s()./-]+$/.test(trimmed) && digits.length >= 7 && digits.length <= 15
}
