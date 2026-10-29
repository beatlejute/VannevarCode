const hexArray = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const hex0 = hexArray[0x0];
const hex1 = hexArray[0x1];
const hexA = hexArray[0xA];
const hexFF = hexArray[0xFF];
const escapes = ["newline\n", "tab\t", "carriage\r", "form\f", "vertical\v", "null\0", "hex\x41", "unicode\u00e9"];
const escape0 = escapes[0];
const escape1 = escapes[1];
const escape2 = escapes[2];
const duplicates = ["a", "b", "a", "c", "b", "d"];
const dup0 = duplicates[0];
const dup2 = duplicates[2];
const dup4 = duplicates[4];
const multilineSource = `const multiline = "first line
second line
third line";`;
const multilineArray = [
    "line1",
    "line2",
    "line3"
];
const multi0 = multilineArray[0];
const multi1 = multilineArray[1];
const multi2 = multilineArray[2];