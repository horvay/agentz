export interface AvatarDefinition {
  id:
    | "marmalade"
    | "nyx"
    | "byte"
    | "glimmer"
    | "wisp"
    | "rufus"
    | "selene"
    | "bamboo"
    | "mochi"
    | "pyra";
  label: string;
  idleSrc: string;
  workingSrc: string;
  questionSrc: string;
  callingSrc: string;
}

export type AvatarVisualState = "idle" | "working" | "question" | "calling";

const avatarStateImages = import.meta.glob("../../assets/avatars/*/*.jpg", {
  eager: true,
  import: "default",
}) as Record<string, string>;

function stateSrc(id: AvatarDefinition["id"], state: AvatarVisualState): string {
  return avatarStateImages[`../../assets/avatars/${id}/${state}.jpg`] ?? "";
}

export const avatarCatalog: AvatarDefinition[] = [
  {
    id: "marmalade",
    label: "Marmalade",
    idleSrc: stateSrc("marmalade", "idle"),
    workingSrc: stateSrc("marmalade", "working"),
    questionSrc: stateSrc("marmalade", "question"),
    callingSrc: stateSrc("marmalade", "calling"),
  },
  {
    id: "nyx",
    label: "Nyx",
    idleSrc: stateSrc("nyx", "idle"),
    workingSrc: stateSrc("nyx", "working"),
    questionSrc: stateSrc("nyx", "question"),
    callingSrc: stateSrc("nyx", "calling"),
  },
  {
    id: "byte",
    label: "Byte",
    idleSrc: stateSrc("byte", "idle"),
    workingSrc: stateSrc("byte", "working"),
    questionSrc: stateSrc("byte", "question"),
    callingSrc: stateSrc("byte", "calling"),
  },
  {
    id: "glimmer",
    label: "Glimmer",
    idleSrc: stateSrc("glimmer", "idle"),
    workingSrc: stateSrc("glimmer", "working"),
    questionSrc: stateSrc("glimmer", "question"),
    callingSrc: stateSrc("glimmer", "calling"),
  },
  {
    id: "wisp",
    label: "Wisp",
    idleSrc: stateSrc("wisp", "idle"),
    workingSrc: stateSrc("wisp", "working"),
    questionSrc: stateSrc("wisp", "question"),
    callingSrc: stateSrc("wisp", "calling"),
  },
  {
    id: "rufus",
    label: "Rufus",
    idleSrc: stateSrc("rufus", "idle"),
    workingSrc: stateSrc("rufus", "working"),
    questionSrc: stateSrc("rufus", "question"),
    callingSrc: stateSrc("rufus", "calling"),
  },
  {
    id: "selene",
    label: "Selene",
    idleSrc: stateSrc("selene", "idle"),
    workingSrc: stateSrc("selene", "working"),
    questionSrc: stateSrc("selene", "question"),
    callingSrc: stateSrc("selene", "calling"),
  },
  {
    id: "bamboo",
    label: "Bamboo",
    idleSrc: stateSrc("bamboo", "idle"),
    workingSrc: stateSrc("bamboo", "working"),
    questionSrc: stateSrc("bamboo", "question"),
    callingSrc: stateSrc("bamboo", "calling"),
  },
  {
    id: "mochi",
    label: "Mochi",
    idleSrc: stateSrc("mochi", "idle"),
    workingSrc: stateSrc("mochi", "working"),
    questionSrc: stateSrc("mochi", "question"),
    callingSrc: stateSrc("mochi", "calling"),
  },
  {
    id: "pyra",
    label: "Pyra",
    idleSrc: stateSrc("pyra", "idle"),
    workingSrc: stateSrc("pyra", "working"),
    questionSrc: stateSrc("pyra", "question"),
    callingSrc: stateSrc("pyra", "calling"),
  },
];

export type AvatarId = AvatarDefinition["id"];
