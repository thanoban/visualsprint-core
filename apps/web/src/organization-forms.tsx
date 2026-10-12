import { useState } from "react";
import { Api, customerSchema, projectSchema, meetingSchema, type Customer } from "./api.js";
import { Form, useCommand } from "./ui.js";

export function OrganizationForms({
  api,
  workspaceId,
  customers,
  reload,
}: {
  api: Api;
  workspaceId: string;
  customers: Customer[];
  reload: () => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [customerId, setCustomerId] = useState("");
  const customer = useCommand();
  const project = useCommand();
  return (
    <>
      <Form
        title="New customer"
        button="Add customer"
        command={customer}
        submit={() =>
          void customer.run(
            { customerName },
            (key) =>
              api.request(`${api.scope(workspaceId)}/customers`, customerSchema, {
                method: "POST",
                body: { name: customerName },
                key,
              }),
            () => {
              setCustomerName("");
              reload();
            },
          )
        }
      >
        <label>
          Customer name
          <input
            required
            maxLength={200}
            value={customerName}
            onChange={(event) => setCustomerName(event.target.value)}
          />
        </label>
      </Form>
      <Form
        title="New project"
        button="Add project"
        command={project}
        submit={() =>
          void project.run(
            { projectName, customerId },
            (key) =>
              api.request(`${api.scope(workspaceId)}/projects`, projectSchema, {
                method: "POST",
                body: { name: projectName, customerId: customerId || null },
                key,
              }),
            () => {
              setProjectName("");
              reload();
            },
          )
        }
      >
        <label>
          Project name
          <input
            required
            maxLength={200}
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </label>
        <label>
          Customer
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Internal team</option>
            {customers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </Form>
    </>
  );
}
export function MeetingForm({
  api,
  workspaceId,
  reload,
}: {
  api: Api;
  workspaceId: string;
  reload: () => void;
}) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const command = useCommand();
  return (
    <Form
      title="New private meeting"
      button="Create meeting"
      command={command}
      submit={() =>
        void command.run(
          { title, link },
          (key) =>
            api.request(`${api.scope(workspaceId)}/meetings`, meetingSchema, {
              method: "POST",
              body: { title, joinUrl: link || null },
              key,
            }),
          () => {
            setTitle("");
            setLink("");
            reload();
          },
        )
      }
    >
      <label>
        Meeting title
        <input
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Meeting link (optional)
        <input
          type="url"
          maxLength={4096}
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://meet.google.com/…"
        />
      </label>
      <p className="hint">Creates a private meeting record. Capture is not started by this form.</p>
    </Form>
  );
}
