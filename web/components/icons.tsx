// Dashboard icons: Hugeicons' free stroke-rounded set (MIT), as Town draws them (24 grid, stroke 2).
// One place maps the desk's names to Hugeicons, so call sites read like any icon component.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Analytics01Icon,
  PaintBoardIcon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandDiagonal01Icon,
  ArrowLeft01Icon,
  ArrowLeftDoubleIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowRightDoubleIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  BookOpen01Icon,
  Bug01Icon,
  BubbleChatIcon,
  Clock01Icon,
  Coffee02Icon,
  Cancel01Icon,
  ComputerIcon,
  Contact01Icon,
  Copy01Icon,
  Delete02Icon,
  CursorDisabled01Icon,
  Download04Icon,
  Edit02Icon,
  HourglassIcon,
  MousePointerClickIcon,
  File01Icon,
  FlashIcon as HugeFlashIcon,
  Globe02Icon,
  HelpCircleIcon,
  Home01Icon,
  InformationCircleIcon,
  InboxIcon as HugeInboxIcon,
  Key01Icon,
  LayoutThreeColumnIcon,
  LinkSquare02Icon,
  McpServerIcon,
  Logout01Icon,
  Mail01Icon,
  MessageMultiple01Icon,
  SlackIcon as HugeSlackIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Notification01Icon,
  PlusSignIcon,
  RefreshIcon as HugeRefreshIcon,
  Search01Icon,
  Settings02Icon,
  SidebarLeft01Icon,
  SourceCodeIcon,
  SparklesIcon,
  StopIcon as HugeStopIcon,
  Tag01Icon,
  Sun03Icon,
  TextIcon as HugeTextIcon,
  ThumbsDownIcon as HugeThumbsDownIcon,
  ThumbsUpIcon as HugeThumbsUpIcon,
  Tick02Icon,
  Upload04Icon,
  UserMultipleIcon,
  UserSwitchIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;

function make(icon: IconSvgElement) {
  return function Icon(props: IconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" {...props} />;
  };
}

export const ArrowDownIcon = make(ArrowDown02Icon);
export const ArrowRightIcon = make(ArrowRight02Icon);
export const ArrowUpIcon = make(ArrowUp02Icon);
export const BookOpenIcon = make(BookOpen01Icon);
export const BugIcon = make(Bug01Icon);
export const ChatIcon = make(BubbleChatIcon);
export const ClockIcon = make(Clock01Icon);
export const CoffeeIcon = make(Coffee02Icon);
export const ChannelsIcon = make(MessageMultiple01Icon);
export const MailIcon = make(Mail01Icon);
export const SlackIcon = make(HugeSlackIcon);
export const PaletteIcon = make(PaintBoardIcon);
export const CodeIcon = make(SourceCodeIcon);
export const ChartColumnIcon = make(Analytics01Icon);
export const CheckIcon = make(Tick02Icon);
export const ChevronLeftIcon = make(ArrowLeft01Icon);
export const ChevronsLeftIcon = make(ArrowLeftDoubleIcon);
export const ChevronsRightIcon = make(ArrowRightDoubleIcon);
export const ChevronDownIcon = make(ArrowDown01Icon);
export const ChevronRightIcon = make(ArrowRight01Icon);
export const ChevronUpIcon = make(ArrowUp01Icon);
export const ContactsIcon = make(Contact01Icon);
export const CopyIcon = make(Copy01Icon);
export const ColumnsIcon = make(LayoutThreeColumnIcon);
export const DownloadIcon = make(Download04Icon);
export const EditIcon = make(Edit02Icon);
export const ExpandIcon = make(ArrowExpandDiagonal01Icon);
export const ExternalLinkIcon = make(LinkSquare02Icon);
export const McpIcon = make(McpServerIcon);
export const FileIcon = make(File01Icon);
export const FlashIcon = make(HugeFlashIcon);
export const GlobeIcon = make(Globe02Icon);
export const HelpIcon = make(HelpCircleIcon);
export const HomeIcon = make(Home01Icon);
export const InfoIcon = make(InformationCircleIcon);
export const InboxIcon = make(HugeInboxIcon);
export const KeyIcon = make(Key01Icon);
export const MoreIcon = make(MoreHorizontalIcon);
export const NotificationIcon = make(Notification01Icon);
export const MonitorIcon = make(ComputerIcon);
export const PlusIcon = make(PlusSignIcon);
export const MoonIcon = make(Moon02Icon);
export const RefreshIcon = make(HugeRefreshIcon);
export const SearchIcon = make(Search01Icon);
export const SettingsIcon = make(Settings02Icon);
export const SidebarIcon = make(SidebarLeft01Icon);
export const SignOutIcon = make(Logout01Icon);
export const SparkleIcon = make(SparklesIcon);
/** The desk assistant's mark: an eight-armed asterisk (Hugeicons' free set has only six arms), drawn on the same grid. */
export const AsteriskIcon = make([
  ["path", { d: "M12 3.5V20.5M3.5 12H20.5M6 6L18 18M18 6L6 18", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5", key: "0" }],
] as IconSvgElement);
/** The AI wherever the desk shows it (the Agent page, AI stats, assistant cards): the same asterisk, not a robot (the user's call). */
export const BotIcon = AsteriskIcon;
export const StopIcon = make(HugeStopIcon);
export const SunIcon = make(Sun03Icon);
export const TextIcon = make(HugeTextIcon);
export const ToolIcon = make(Wrench01Icon);
export const TrashIcon = make(Delete02Icon);
export const UploadIcon = make(Upload04Icon);
export const UsersIcon = make(UserMultipleIcon);
export const XIcon = make(Cancel01Icon);
export const ThumbsUpIcon = make(HugeThumbsUpIcon);
// Reports' struggle chips (D-124): rage click, a click that did nothing, stuck on a page.
export const RageClickIcon = make(MousePointerClickIcon);
export const DeadClickIcon = make(CursorDisabled01Icon);
export const StuckIcon = make(HourglassIcon);
export const ThumbsDownIcon = make(HugeThumbsDownIcon);
// Reports' Top topics stats (D-125): topics, and chats handed to the team.
export const TagIcon = make(Tag01Icon);
export const HandoffIcon = make(UserSwitchIcon);
