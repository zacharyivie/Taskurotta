import taskurottaIcon from "../assets/roundel.png";

export default function TaskurottaMark({ className = "" }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={`block shrink-0 ${className}`}
      draggable="false"
      src={taskurottaIcon}
    />
  );
}
